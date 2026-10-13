import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { saveAccount, saveAsset } from "@/lib/services/entities";
import { createTransaction, updateTransaction } from "@/lib/services/ledger";
import { upsertManualPrice } from "@/lib/services/market";
import { backupDatabase, restoreDatabase } from "../../scripts/lib/backup";
import { databaseConnection, restoreTarget, runPostgres } from "../../scripts/lib/postgres";

const suite = process.env.RUN_INTEGRATION === "1" && process.env.RUN_BACKUP_TESTS === "1" ? describe : describe.skip;

suite("encrypted backup and fresh-database restore", () => {
  const userId = randomUUID();
  const database = `portlyzer_restore_${randomUUID().replaceAll("-", "")}`;
  const secret = randomBytes(48).toString("hex");
  let directory: string;
  let archive: string;
  let connection: URL;
  let restored: PrismaClient | undefined;
  let buyId: string;

  beforeAll(async () => {
    connection = databaseConnection();
    if (!/\/portlyzer_test(?:_[a-z0-9_]+)?$/.test(connection.pathname)) {
      throw new Error("Backup integration requires an explicitly isolated portlyzer_test database, never the user's local database.");
    }
    directory = mkdtempSync(join(tmpdir(), "portlyzer-backup-test-"));
    archive = join(directory, "fixture.pbackup");
    await db.user.create({ data: { id: userId, name: "Restore fixture", email: `${userId}@example.invalid` } });
    const account = await saveAccount(userId, { name: "Restore account", currency: "USD" });
    const asset = await saveAsset(userId, { symbol: "RESTORE", name: "Restore stock", exchange: "NASDAQ", currency: "USD", assetClass: "STOCK" });
    await createTransaction(userId, { accountId: account.id, date: "2025-01-02", kind: "DEPOSIT", currency: "USD", amount: "1000" });
    const purchase = { accountId: account.id, date: "2025-01-02", kind: "BUY", assetId: asset.id, currency: "USD", quantity: "2", price: "100", fee: "1" };
    const buy = await createTransaction(userId, purchase);
    buyId = buy.id;
    await updateTransaction(userId, buy.id, { ...purchase, price: "101", revision: buy.revision });
    await createTransaction(userId, { accountId: account.id, date: "2025-01-03", kind: "DIVIDEND", assetId: asset.id, currency: "USD", amount: "5", tax: "1" });
    await upsertManualPrice(userId, { assetId: asset.id, date: "2025-01-04", currency: "USD", close: "110" });
  });

  afterAll(async () => {
    await restored?.$disconnect();
    if (connection && directory) {
      const exists = runPostgres("psql", ["-XAt", "-c", `SELECT 1 FROM pg_database WHERE datname = '${database}'`], connection, "postgres");
      if (exists === "1") runPostgres("dropdb", ["--maintenance-db=postgres", database], connection, "postgres");
      await db.user.deleteMany({ where: { id: userId } });
      for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
      rmdirSync(directory);
    }
    await db.$disconnect();
  });

  it("encrypts the dump and restores the exact ledger, revisions and financial output", async () => {
    const backup = await backupDatabase(connection, archive, secret);
    expect(backup.bytes).toBeGreaterThan(1000);
    expect(readFileSync(archive).includes(Buffer.from(userId))).toBe(false);
    await expect(backupDatabase(connection, archive, secret)).rejects.toThrow("overwriting");
    const result = await restoreDatabase(connection, archive, database, secret);
    expect(result.counts.transactions).toBeGreaterThanOrEqual(3);
    const target = restoreTarget(connection, database);
    restored = new PrismaClient({ datasourceUrl: target.toString() });
    expect(await restored.user.findUnique({ where: { id: userId } })).not.toBeNull();
    expect((await restored.transaction.findUniqueOrThrow({ where: { id: buyId } })).price?.toString()).toBe("101");
    expect(await restored.transactionRevision.count({ where: { userId } })).toBe(4);
    expect(await restored.originalTransaction.count({ where: { userId } })).toBe(3);
    const probe = spawnSync(process.execPath, ["--import=tsx", "--input-type=module", "-e",
      `import { getWorkspace } from './src/lib/services/workspace.ts'; import { db } from './src/lib/db.ts'; try { const data = await getWorkspace('${userId}', {from:'2025-01-02',to:'2025-01-04',currency:'USD'}); console.log(JSON.stringify({value:data.analysis.summary.totalValue,pnl:data.analysis.summary.totalPnl,transactions:data.transactions.length})); } finally { await db.$disconnect(); }`],
    { env: { ...process.env, DATABASE_URL: target.toString() }, encoding: "utf8", timeout: 30000 });
    expect(probe.status).toBe(0);
    expect(JSON.parse(probe.stdout.trim())).toEqual({ value: "1021", pnl: "21", transactions: 3 });
    await expect(restoreDatabase(connection, archive, database, secret)).rejects.toThrow("createdb failed");
    expect(await restored.transaction.count({ where: { userId } })).toBe(3);
  });

  it("rejects wrong keys and tampered archives before creating a target database", async () => {
    await expect(restoreDatabase(connection, archive, database, "wrong-secret-of-at-least-32-characters")).rejects.toThrow("authentication/decryption");
    const corrupted = join(directory, "corrupted.pbackup");
    const bytes = readFileSync(archive);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(corrupted, bytes);
    await expect(restoreDatabase(connection, corrupted, database, secret)).rejects.toThrow("authentication/decryption");
    expect(await restored!.transaction.count({ where: { userId } })).toBe(3);
  });
});
