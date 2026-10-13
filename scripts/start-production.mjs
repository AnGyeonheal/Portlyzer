import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

try {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const { values } = parseArgs({
    options: { port: { type: "string" }, hostname: { type: "string" } },
    strict: true, allowPositionals: false,
  });
  const port = values.port ?? process.env.PORT ?? "3000";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Use a port from 1 to 65535.");
  const hostname = values.hostname ?? "127.0.0.1";
  if (process.env.APP_MODE !== "public" && !["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    throw new Error("Local mode only allows loopback binding.");
  }
  const marker = resolve(".next", "standalone", ".portlyzer-ready.json");
  if (!existsSync(marker) || JSON.parse(readFileSync(marker, "utf8")).buildId !== readFileSync(resolve(".next", "BUILD_ID"), "utf8").trim()) {
    throw new Error("Standalone output is missing or stale. Run npm run build.");
  }
  process.env.NODE_ENV = "production";
  process.env.PORT = port;
  process.env.HOSTNAME = hostname;
  await import(pathToFileURL(resolve(".next", "standalone", "server.js")).href);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Production startup failed.");
  process.exitCode = 1;
}
