import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { runtimeConfig } from "../src/lib/environment";
import { databaseConnection, loadEnvironment } from "./lib/postgres";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
process.env.PATH = `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
const stateDirectory = join(root, ".local-state");
const stateFile = join(stateDirectory, "app.json");
const endpoint = `\\\\.\\pipe\\portlyzer-${createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 24)}`;
const stateSchema = z.object({ root: z.string(), token: z.string().regex(/^[a-f0-9]{64}$/), pgData: z.string(), url: z.string() });
const commandSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(["status", "stop"]) }).strict();

function run(args: string[]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.error) throw new Error(`Local command could not start (${result.error.name}).`);
  if (result.status !== 0) throw new Error(`Local command failed (exit ${result.status}).`);
}

function savedState() {
  if (!existsSync(stateFile)) throw new Error("No managed app state exists. Use start; unmanaged servers are never stopped.");
  const state = stateSchema.parse(JSON.parse(readFileSync(stateFile, "utf8")));
  if (state.root !== root) throw new Error("App state belongs to a different project.");
  return state;
}

function control(action: "status" | "stop") {
  const state = savedState();
  return new Promise<{ status: string; url?: string; phase?: string }>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let response = "";
    socket.setTimeout(10000, () => socket.destroy(new Error("Local control request timed out.")));
    socket.once("error", () => reject(new Error("The managed launcher is not reachable. No unrelated process was stopped; use start to reclaim stale state.")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ action, token: state.token })}\n`));
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.length > 4096) socket.destroy(new Error("Invalid local control response."));
    });
    socket.once("end", () => {
      try {
        const result = z.object({ status: z.string(), url: z.string().optional(), phase: z.string().optional() }).parse(JSON.parse(response));
        if (result.status !== "OK") throw new Error("Local control request was refused.");
        resolve(result);
      } catch { reject(new Error("Invalid or unauthorized local control response.")); }
    });
  });
}

async function checkHealth(url: string) {
  const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok || (await response.json()).status !== "ok") throw new Error("Application/database health check failed.");
}

async function start(skipBuild: boolean, url: string) {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  let child: ChildProcess | undefined;
  let exited: Promise<void> | undefined;
  let spawnFailure: Error | undefined;
  let stopping = false;
  let phase = "starting";
  async function stopChild() {
    stopping = true;
    phase = "stopping";
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child?.kill("SIGKILL"), 10000);
      try { await exited; } finally { clearTimeout(timer); }
    }
  }
  const server = createServer((socket) => {
    let data = "";
    socket.setTimeout(10000, () => socket.destroy());
    socket.on("error", () => console.error("Local control connection failed; no credentials were logged."));
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > 4096) { socket.end('{"status":"INVALID_REQUEST"}'); return; }
      if (!data.includes("\n")) return;
      let command: z.infer<typeof commandSchema>;
      try { command = commandSchema.parse(JSON.parse(data.slice(0, data.indexOf("\n")))); }
      catch { socket.end('{"status":"INVALID_REQUEST"}'); return; }
      if (!timingSafeEqual(Buffer.from(command.token), Buffer.from(token))) { socket.end('{"status":"DENIED"}'); return; }
      socket.removeAllListeners("data");
      if (command.action === "status") socket.end(JSON.stringify({ status: "OK", url, phase }));
      else void stopChild().then(() => socket.end(JSON.stringify({ status: "OK", url, phase }))).catch(() => socket.end('{"status":"STOP_FAILED"}'));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(new Error("Another launcher owns this project. Use status/stop; do not start competing servers.")));
    server.listen(endpoint, resolve);
  });
  const onSignal = () => { void stopChild().catch(() => { process.exitCode = 1; }); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    if (existsSync(stateFile)) {
      savedState();
      unlinkSync(stateFile);
    }
    writeFileSync(stateFile, JSON.stringify({ root, token, url, pgData: resolve(process.env.PG_DATA ?? ".local-db") }), { flag: "wx", mode: 0o600 });
    const address = new URL(url);
    const port = address.port || "80";
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", () => reject(new Error("The configured app port is occupied by an unmanaged process. Nothing was stopped.")));
      probe.listen(Number(port), address.hostname, () => probe.close((error) => error ? reject(error) : resolve()));
    });
    run(["--import=tsx", "scripts/local-database.ts", "start"]);
    run(["node_modules/prisma/build/index.js", "migrate", "deploy"]);
    if (!skipBuild) {
      run(["node_modules/next/dist/bin/next", "build"]);
      run(["--import=tsx", "scripts/prepare-standalone.ts"]);
    }
    if (stopping) return;
    child = spawn(process.execPath, ["scripts/start-production.mjs", "--port", port, "--hostname", address.hostname], {
      cwd: root, env: process.env, stdio: "inherit",
    });
    exited = new Promise<void>((resolve) => {
      child!.once("error", () => { spawnFailure = new Error("Production server could not start."); resolve(); });
      child!.once("exit", (code) => {
        if (code !== 0 && !stopping) console.error(`Production server exited (code ${code}).`);
        resolve();
      });
    });
    let healthy = false;
    let lastHealthError = "No healthy response.";
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null && !stopping && !spawnFailure) {
      try { await checkHealth(url); healthy = true; break; }
      catch (error) {
        lastHealthError = error instanceof Error ? error.message : "Unknown health check error.";
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!healthy) throw spawnFailure ?? new Error(`The production app did not become healthy within 120 seconds. ${lastHealthError}`);
    phase = "running";
    console.info(`Ready: ${url} (standalone production). Use portlyzer.cmd stop in another terminal to stop this app and its local DB.`);
    await exited;
    if (!stopping && child.exitCode !== 0) throw new Error("The production server exited unexpectedly.");
  } finally {
    await stopChild();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (existsSync(stateFile) && savedState().token === token) unlinkSync(stateFile);
  }
}

async function main() {
  if (process.platform !== "win32") throw new Error("This local process controller targets Windows. Use Docker Compose or the documented build/start and database commands on other systems.");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!/^\d+\.\d+\.\d+$/.test(process.versions.node) || major < 22 || (major === 22 && minor < 12)) {
    throw new Error("Use stable Node.js 24 LTS (the Windows launcher prefers the project-local copy).");
  }
  loadEnvironment();
  const { positionals, values } = parseArgs({ options: {
    "skip-build": { type: "boolean" }, output: { type: "string" }, file: { type: "string" }, database: { type: "string" },
  }, allowPositionals: true, strict: true });
  const action = positionals[0] ?? "start";
  if (positionals.length > 1 || !["start", "status", "stop", "backup", "restore", "check"].includes(action) ||
    (values["skip-build"] && action !== "start") || (values.output && action !== "backup") ||
    ((values.file || values.database) && action !== "restore")) {
    throw new Error("Usage: portlyzer.cmd start [--skip-build] | status | stop | backup [--output FILE] | restore --file FILE --database NEW_NAME | check");
  }
  const config = runtimeConfig();
  if (config.mode !== "local" || !config.authUrl.startsWith("http://")) throw new Error("This launcher manages local HTTP only, not public deployments.");
  const connection = databaseConnection();
  if (!["localhost", "127.0.0.1"].includes(connection.hostname)) throw new Error("This launcher only manages a loopback PostgreSQL instance.");
  if (action === "start") await start(!!values["skip-build"], config.authUrl);
  else if (action === "status") {
    const status = await control("status");
    if (status.phase !== "running" || !status.url) throw new Error(`The launcher is ${status.phase}; the app is not ready.`);
    await checkHealth(status.url);
    console.info(`Healthy: ${status.url} (standalone production)`);
    run(["--import=tsx", "scripts/local-database.ts", "status"]);
  } else if (action === "stop") {
    const state = savedState();
    if (state.pgData !== resolve(process.env.PG_DATA ?? ".local-db")) throw new Error("PG_DATA changed since startup. Refusing to stop a different database.");
    await control("stop");
    run(["--import=tsx", "scripts/local-database.ts", "stop"]);
  } else if (action === "backup") run(["--import=tsx", "scripts/database-backup.ts", "backup", ...(values.output ? ["--output", values.output] : [])]);
  else if (action === "restore") {
    if (!values.file || !values.database) throw new Error("Restore requires --file and --database NEW_NAME.");
    run(["--import=tsx", "scripts/database-backup.ts", "restore", "--file", values.file, "--database", values.database]);
  }
  else run(["--import=tsx", "scripts/check-readiness.ts"]);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error && !(error instanceof z.ZodError) ? error.message : "Invalid local launcher state or arguments.");
  process.exitCode = 1;
});
