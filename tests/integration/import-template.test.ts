import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { IMPORT_TEMPLATE, templateMapping } from "@/lib/import-template";
import { createImportTemplate } from "@/lib/services/import-template";
import { confirmImport, uploadImport, validateImport } from "@/lib/services/imports";
import { importManualPrices } from "@/lib/services/market";
import { getWorkspace } from "@/lib/services/workspace";

const suite = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

suite("standard Excel template ledger integration", () => {
  let userId: string;
  let otherId: string;
  let accountId: string;
  let otherAccountId: string;
  let template: Uint8Array<ArrayBuffer>;

  beforeAll(async () => { template = await createImportTemplate(); });
  beforeEach(async () => {
    userId = randomUUID(); otherId = randomUUID();
    accountId = randomUUID(); otherAccountId = randomUUID();
    await db.user.createMany({ data: [userId, otherId].map((id) => ({ id, name: "Excel template fixture", email: `${id}@example.invalid` })) });
    await db.brokerAccount.createMany({ data: [
      { id: accountId, userId, name: "Template account", currency: "USD" },
      { id: otherAccountId, userId: otherId, name: "Other account", currency: "USD" },
    ] });
  });
  afterEach(async () => { await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } }); });
  afterAll(async () => { await db.$disconnect(); });

  async function filled(edit?: (sheet: ExcelJS.Worksheet) => void) {
    const file = new ExcelJS.Workbook();
    await file.xlsx.load(template.buffer);
    const sheet = file.worksheets[0];
    sheet.getRow(2).values = ["2025-01-02", "입금", "USD", "", "", "", "", "5000", "", "", "", "", "template-deposit"];
    sheet.getRow(3).values = ["2025-01-03", "매수", "USD", "AAPL", "NASDAQ", "not-a-number", "180", "", "1", "", "", "", "template-buy"];
    sheet.getRow(4).values = ["2025-01-06", "배당", "USD", "AAPL", "NASDAQ", "", "", "5", "", "0.75", "", "", "template-dividend"];
    sheet.getRow(5).values = ["2025-01-07", "매도", "USD", "AAPL", "NASDAQ", "3", "200", "", "1", "", "", "", "template-sell"];
    edit?.(sheet);
    return new Uint8Array(await file.xlsx.writeBuffer());
  }

  it("validates and corrects the template, then commits once with original rows intact", async () => {
    const bytes = await filled();
    const upload = await uploadImport(userId, accountId, IMPORT_TEMPLATE.filename, bytes, IMPORT_TEMPLATE.id);
    expect(upload.rows).toHaveLength(4);
    expect(await db.transaction.count({ where: { userId } })).toBe(0);
    const invalid = await validateImport(userId, upload.jobId, { revision: upload.revision, mapping: templateMapping() });
    expect(invalid.valid).toBe(false);
    expect(invalid.rows.find((row) => row.rowNumber === 3)?.errors.some((error) => error.field === "quantity")).toBe(true);
    expect(await db.transaction.count({ where: { userId } })).toBe(0);
    const valid = await validateImport(userId, upload.jobId, {
      revision: invalid.revision, mapping: templateMapping(), changes: { "3": { quantity: "10" } },
    });
    expect(valid.valid).toBe(true);
    expect(valid.summary).toEqual({ total: 4, keep: 4, skip: 0, errors: 0 });
    await expect(confirmImport(userId, upload.jobId, valid.revision)).resolves.toMatchObject({ created: 4, alreadyConfirmed: false });
    const original = await db.originalTransaction.findFirstOrThrow({ where: { userId, rowNumber: 3 } });
    expect(original.rawData).toMatchObject({ "수량": "not-a-number", "거래 유형": "매수" });
    await importManualPrices(userId, { rows: [
      { symbol: "AAPL", exchange: "NASDAQ", date: "2025-01-03", close: "180", currency: "USD" },
      { symbol: "AAPL", exchange: "NASDAQ", date: "2025-01-06", close: "200", currency: "USD" },
      { symbol: "AAPL", exchange: "NASDAQ", date: "2025-01-07", close: "210", currency: "USD" },
    ] });
    const data = await getWorkspace(userId, { from: "2025-01-02", to: "2025-01-07", currency: "USD" });
    expect(data.analysis.summary.totalValue).toBe("5272.25");
    expect(data.analysis.summary.totalPnl).toBe("272.25");
    await expect(uploadImport(userId, accountId, IMPORT_TEMPLATE.filename, bytes, IMPORT_TEMPLATE.id)).resolves.toMatchObject({
      duplicateFile: true, jobId: upload.jobId, status: "CONFIRMED",
    });
    await expect(confirmImport(userId, upload.jobId, valid.revision)).resolves.toMatchObject({ alreadyConfirmed: true });
    expect(await db.transaction.count({ where: { userId } })).toBe(4);
  });

  it("rejects changed headers or template versions without creating an import job", async () => {
    const bytes = await filled((sheet) => { sheet.getCell("A1").value = "날짜"; });
    await expect(uploadImport(userId, accountId, IMPORT_TEMPLATE.filename, bytes, IMPORT_TEMPLATE.id)).rejects.toMatchObject({ code: "IMPORT_TEMPLATE_MISMATCH" });
    await expect(uploadImport(userId, accountId, IMPORT_TEMPLATE.filename, await filled(), "unknown-version")).rejects.toMatchObject({ code: "IMPORT_TEMPLATE_MISMATCH" });
    expect(await db.importJob.count({ where: { userId } })).toBe(0);
    const custom = await uploadImport(userId, accountId, "custom.xlsx", bytes);
    expect(custom.rows).toHaveLength(4);
  });

  it("never interprets CSV as the Excel template or imports to another user's account", async () => {
    await expect(uploadImport(userId, accountId, "legacy.csv", Buffer.from("date,kind,currency,amount\n2025-01-02,DEPOSIT,USD,1"), IMPORT_TEMPLATE.id))
      .rejects.toMatchObject({ code: "IMPORT_TEMPLATE_MISMATCH" });
    await expect(uploadImport(userId, otherAccountId, IMPORT_TEMPLATE.filename, await filled(), IMPORT_TEMPLATE.id)).rejects.toMatchObject({ status: 404 });
    expect(await db.importJob.count({ where: { userId } })).toBe(0);
    expect(await db.importJob.count({ where: { userId: otherId } })).toBe(0);
  });

  it("preserves real Excel row numbers when the user excludes an interior blank row", async () => {
    const bytes = await filled((sheet) => {
      sheet.getRow(3).values = [];
      sheet.getRow(4).values = ["2025-01-03", "매수", "USD", "005930", "KRX", "1", "100"];
      sheet.getRow(5).values = [];
    });
    const upload = await uploadImport(userId, accountId, IMPORT_TEMPLATE.filename, bytes, IMPORT_TEMPLATE.id);
    const validation = await validateImport(userId, upload.jobId, { revision: upload.revision, mapping: templateMapping(), decisions: { "3": "SKIP" } });
    expect(validation.valid).toBe(true);
    expect(validation.rows.map((row) => row.rowNumber)).toEqual([2, 3, 4]);
    await confirmImport(userId, upload.jobId, validation.revision);
    expect((await db.originalTransaction.findMany({ where: { userId }, orderBy: { rowNumber: "asc" } })).map((row) => row.rowNumber)).toEqual([2, 4]);
    expect((await db.asset.findFirstOrThrow({ where: { userId } })).symbol).toBe("005930");
  });
});
