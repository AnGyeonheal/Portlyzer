import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

if (existsSync(".env")) throw new Error(".env already exists; it was not overwritten.");
const databasePort = process.env.LOCAL_DATABASE_PORT ?? "5432";
const appPort = process.env.PORT ?? "3000";
if (!/^\d{4,5}$/.test(databasePort) || !/^\d{4,5}$/.test(appPort)) throw new Error("Invalid local port.");
const environment = readFileSync(".env.example", "utf8")
  .replaceAll("local-development-only", randomBytes(24).toString("hex"))
  .replace("localhost:5432", `127.0.0.1:${databasePort}`)
  .replace("localhost:3000", `127.0.0.1:${appPort}`)
  .replace("replace-with-at-least-32-random-characters", randomBytes(48).toString("hex"));
writeFileSync(".env", environment, { mode: 0o600, flag: "wx" });
console.info("Created ignored .env with random development credentials. No credentials were printed.");
