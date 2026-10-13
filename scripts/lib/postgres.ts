import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export function loadEnvironment() {
  if (existsSync(".env")) process.loadEnvFile(".env");
}

export function databaseConnection(value = process.env.DATABASE_URL) {
  if (!value || !URL.canParse(value)) throw new Error("Set a valid DATABASE_URL.");
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username ||
    !url.password || url.pathname.length < 2 || url.hash) throw new Error("DATABASE_URL must identify an authenticated PostgreSQL database.");
  if (url.searchParams.has("schema") && url.searchParams.get("schema") !== "public") {
    throw new Error("Portlyzer operations require the public schema.");
  }
  const supported = new Set(["schema", "sslmode", "sslrootcert", "sslcert", "sslkey", "connection_limit", "pool_timeout", "connect_timeout", "pgbouncer"]);
  for (const key of url.searchParams.keys()) {
    if (!supported.has(key)) throw new Error("DATABASE_URL contains an unsupported connection option; configure PostgreSQL tools explicitly.");
  }
  return url;
}

export function postgresEnvironment(connection: URL, database = decodeURIComponent(connection.pathname.slice(1))): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: connection.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: connection.port || "5432",
    PGUSER: decodeURIComponent(connection.username),
    PGPASSWORD: decodeURIComponent(connection.password),
    PGDATABASE: database,
    PGAPPNAME: "portlyzer-operations",
    PGCONNECT_TIMEOUT: connection.searchParams.get("connect_timeout") ?? "10",
    ...Object.fromEntries(["sslmode", "sslrootcert", "sslcert", "sslkey"].map((key) =>
      [`PG${key.toUpperCase()}`, connection.searchParams.get(key) ?? process.env[`PG${key.toUpperCase()}`]])),
  };
}

type PostgresTool = "pg_dump" | "pg_restore" | "psql" | "createdb" | "dropdb" | "pg_ctl" | "initdb" | "pg_isready";

export function postgresBinary(name: PostgresTool) {
  const local = resolve(".local-tools", "pgsql", "bin");
  const bin = process.env.PG_BIN || (existsSync(local) ? local : undefined);
  const executable = `${name}${process.platform === "win32" ? ".exe" : ""}`;
  return bin ? join(bin, executable) : executable;
}

export function runPostgres(name: PostgresTool, args: string[], connection: URL, database?: string) {
  const result = spawnSync(postgresBinary(name), args, {
    env: postgresEnvironment(connection, database), encoding: "utf8", timeout: 120000,
    windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${name} could not run (${result.error.name}). Check PG_BIN and the PostgreSQL tools.`);
  if (result.status !== 0) throw new Error(`${name} failed (exit ${result.status}). Check database connectivity, permissions and the archive; existing databases were not reset.`);
  return result.stdout.trim();
}

export function restoreTarget(connection: URL, name: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name) || ["postgres", "template0", "template1"].includes(name) ||
    name === decodeURIComponent(connection.pathname.slice(1))) {
    throw new Error("Restore requires a new, non-system database name, different from DATABASE_URL (lowercase letters, digits and underscores only).");
  }
  const target = new URL(connection);
  target.pathname = `/${name}`;
  return target;
}
