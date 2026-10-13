import { parseArgs } from "node:util";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { backupDatabase, backupSecret, restoreDatabase } from "./lib/backup";
import { databaseConnection, loadEnvironment } from "./lib/postgres";

async function main() {
  loadEnvironment();
  const { values, positionals } = parseArgs({
    options: { output: { type: "string" }, file: { type: "string" }, database: { type: "string" } },
    allowPositionals: true, strict: true,
  });
  const connection = databaseConnection();
  if (positionals.length !== 1) throw new Error("Use db:backup [--output file] or db:restore --file archive --database NEW_NAME.");
  if (positionals[0] === "backup") {
    if (values.file || values.database) throw new Error("Backup accepts only --output.");
    const output = values.output ?? join(process.env.BACKUP_DIR || ".backups",
      `portlyzer-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.pbackup`);
    console.info(JSON.stringify({ status: "BACKED_UP", ...await backupDatabase(connection, output, backupSecret(true)) }));
  } else if (positionals[0] === "restore") {
    if (!values.file || !values.database || values.output) throw new Error("Restore requires --file and --database NEW_NAME. Existing databases are never overwritten.");
    console.info(JSON.stringify({ status: "RESTORED", ...await restoreDatabase(connection, values.file, values.database, backupSecret()) }));
  } else throw new Error("Unknown backup operation.");
}

void main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: "FAILED", message: error instanceof Error ? error.message : "Database operation failed." }));
  process.exitCode = 1;
});
