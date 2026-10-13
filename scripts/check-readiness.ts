import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runtimeConfig } from "../src/lib/environment";
import { loadEnvironment } from "./lib/postgres";

async function main() {
  loadEnvironment();
  const { values } = parseArgs({ options: { public: { type: "boolean", default: false } }, strict: true });
  const config = runtimeConfig(values.public ? { ...process.env, APP_MODE: "public" } : process.env);
  if (!existsSync(join(".next", "BUILD_ID"))) throw new Error("Production build missing. Run npm run build.");
  const marker = join(".next", "standalone", ".portlyzer-ready.json");
  if (!existsSync(marker) || JSON.parse(readFileSync(marker, "utf8")).buildId !== readFileSync(join(".next", "BUILD_ID"), "utf8").trim()) {
    throw new Error("Standalone packaging is missing or stale. Run npm run build.");
  }
  if (readdirSync(join(".next", "standalone")).some((name) => /^\.env(?:\.|$)/.test(name))) {
    throw new Error("A private environment file is present in the deployment output.");
  }
  const { db } = await import("../src/lib/db");
  try {
    await db.$queryRaw`SELECT 1`;
    const migrations = await db.$queryRaw<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"
    `;
    for (const entry of readdirSync(join("prisma", "migrations"), { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const checksum = createHash("sha256").update(readFileSync(join("prisma", "migrations", entry.name, "migration.sql"))).digest("hex");
      if (!migrations.some((migration) => migration.migration_name === entry.name && migration.checksum === checksum && migration.finished_at && !migration.rolled_back_at)) {
        throw new Error(`Migration ${entry.name} is pending or differs from the applied migration. Run db:migrate and investigate drift.`);
      }
    }
    if (migrations.some((migration) => !migration.finished_at && !migration.rolled_back_at)) throw new Error("An incomplete migration requires operator attention.");
    console.info(JSON.stringify({
      status: "READY", scope: config.mode === "public" ? "public-configuration" : "local-production",
      build: "present", database: "reachable", migrations: "matched",
      emailVerification: config.requireEmailVerification, demo: config.demoEnabled,
      operatorChecks: ["Verified backup restoration", "Real SMTP delivery", "Data-provider rights and coverage", "HTTPS proxy and privacy policy"],
    }));
  } finally { await db.$disconnect(); }
}

void main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: "NOT_READY", message: error instanceof Error && !error.constructor.name.startsWith("Prisma")
    ? error.message : "Database/migration validation failed. Check database connectivity and applied migrations." }));
  process.exitCode = 1;
});
