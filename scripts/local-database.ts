import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

if (existsSync(".env")) process.loadEnvFile(".env");
const connection = process.env.DATABASE_URL;
if (!connection) throw new Error("Set DATABASE_URL before starting the local database.");
const url = new URL(connection);
if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
  throw new Error("db:local only manages a loopback development database.");
}
const bin = process.env.PG_BIN;
if (!bin) throw new Error("Set PG_BIN to the directory containing initdb and pg_ctl.");
const data = resolve(process.env.PG_DATA ?? ".local-db");
const command = process.argv[2] ?? "start";
const executable = (name: string) => join(bin, `${name}${process.platform === "win32" ? ".exe" : ""}`);
const run = (name: string, args: string[], quiet = false) => {
  const result = spawnSync(executable(name), args, {
    encoding: "utf8",
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
    stdio: quiet ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed with status ${result.status}${quiet ? `: ${result.stderr}` : ""}`);
  return result.stdout ?? "";
};

if (command === "stop") {
  run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
} else if (command === "start") {
  mkdirSync(data, { recursive: true });
  if (!existsSync(join(data, "PG_VERSION"))) {
    const passwordFile = join(tmpdir(), `portlyzer-init-${randomUUID()}.txt`);
    writeFileSync(passwordFile, decodeURIComponent(url.password), { mode: 0o600, flag: "wx" });
    try {
      run("initdb", ["-D", data, "-U", decodeURIComponent(url.username), "--pwfile", passwordFile,
        "--auth-host=scram-sha-256", "--auth-local=scram-sha-256", "--encoding=UTF8", "--locale=C"]);
    } finally {
      unlinkSync(passwordFile);
    }
  }
  const status = spawnSync(executable("pg_ctl"), ["-D", data, "status"], { stdio: "ignore" });
  if (status.status !== 0) {
    run("pg_ctl", ["-D", data, "-l", join(data, "postgres.log"), "-o", `-h 127.0.0.1 -p ${url.port || "5432"}`, "-w", "start"]);
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(database)) throw new Error("Use a simple development database name.");
  console.info(`Local PostgreSQL ready on 127.0.0.1:${url.port || "5432"}. Run db:migrate to create/migrate ${database}. Data is persistent.`);
} else {
  throw new Error("Usage: npm run db:local -- start|stop");
}
