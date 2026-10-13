import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { IMPORT_FILE_LIMITS, importFields } from "@/lib/contracts";
import { IMPORT_TEMPLATE, importFieldLabels, matchesTemplateHeaders, suggestImportMapping, templateFields, templateHeaders, templateKinds, templateListLiterals, templateMapping } from "@/lib/import-template";
import { createImportTemplate } from "@/lib/services/import-template";
import { normalizeImportKind, parseImportFile } from "@/lib/services/imports";

let bytes: Uint8Array<ArrayBuffer>;
beforeAll(async () => { bytes = await createImportTemplate(); });

async function workbook() {
  const result = new ExcelJS.Workbook();
  await result.xlsx.load(bytes.buffer);
  return result;
}

async function serialize(value: ExcelJS.Workbook) {
  return new Uint8Array(await value.xlsx.writeBuffer());
}

describe("standard transaction workbook", () => {
  it("has a single visible, formula-free, blank input sheet with fixed Korean headers", async () => {
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThanOrEqual(IMPORT_FILE_LIMITS.bytes);
    const file = await workbook();
    expect(file.worksheets).toHaveLength(1);
    const sheet = file.worksheets[0];
    expect(sheet.name).toBe(IMPORT_TEMPLATE.sheetName);
    expect(sheet.state).toBe("visible");
    expect(sheet.model.merges).toEqual([]);
    expect(sheet.rowCount).toBeLessThanOrEqual(IMPORT_FILE_LIMITS.rows + 1);
    expect(sheet.columnCount).toBe(templateFields.length);
    expect(templateFields.length).toBe(importFields.length);
    expect(new Set(templateFields)).toEqual(new Set(importFields));
    expect(templateFields.map((_, index) => sheet.getRow(1).getCell(index + 1).text)).toEqual(templateHeaders);
    for (let row = 2; row <= sheet.rowCount; row++) expect(sheet.getRow(row).hasValues).toBe(false);
    for (const [index, field] of templateFields.entries()) {
      const cell = sheet.getCell(2, index + 1);
      expect(cell.numFmt).toBe("@");
      expect(cell.dataValidation.promptTitle).toBe(importFieldLabels[field]);
      expect(cell.dataValidation.prompt?.length).toBeLessThanOrEqual(255);
    }
    expect(sheet.getCell("B2").dataValidation.formulae).toEqual([templateListLiterals[0]]);
    expect(sheet.getCell("C2").dataValidation.formulae).toEqual([templateListLiterals[1]]);
    expect(sheet.getCell("O2001").dataValidation.formulae).toEqual([templateListLiterals[1]]);
    for (const [kind, label] of Object.entries(templateKinds)) expect(normalizeImportKind(label)).toBe(kind);
  });

  it("does not treat an unchanged blank download as transactions", async () => {
    await expect(parseImportFile(IMPORT_TEMPLATE.filename, bytes)).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
  });

  it("round-trips text codes and exact decimals while trimming only unused trailing rows", async () => {
    const file = await workbook();
    const sheet = file.worksheets[0];
    sheet.getRow(2).values = ["2025-01-02", "매수", "KRW", "005930", "KRX", "0.000000000001", "123.456789012345", "", "", "", "메모"];
    const result = await parseImportFile(IMPORT_TEMPLATE.filename, await serialize(file));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ 거래일: "2025-01-02", "거래 유형": "매수", "종목 코드": "005930", 수량: "0.000000000001", 단가: "123.456789012345" });
    expect(Object.getPrototypeOf(result.rows[0])).toBeNull();
    expect(matchesTemplateHeaders(result.headers)).toBe(true);
    expect(templateMapping()).toEqual(suggestImportMapping(result.headers));
  });

  it("keeps a blank interior row so Excel row numbers remain accurate", async () => {
    const file = await workbook();
    file.worksheets[0].getRow(2).values = ["2025-01-02", "입금", "USD", "", "", "", "", "1000"];
    file.worksheets[0].getRow(4).values = ["2025-01-03", "출금", "USD", "", "", "", "", "10"];
    const result = await parseImportFile(IMPORT_TEMPLATE.filename, await serialize(file));
    expect(result.rows).toHaveLength(3);
    expect(Object.values(result.rows[1]).every((value) => value === "")).toBe(true);
    expect(result.rows[2].거래일).toBe("2025-01-03");
  });

  it("accepts exactly 2,000 entered rows with the template's validations", async () => {
    const file = await workbook();
    for (let row = 2; row <= IMPORT_FILE_LIMITS.rows + 1; row++) {
      file.worksheets[0].getRow(row).values = ["2025-01-02", "입금", "USD", "", "", "", "", "1"];
    }
    expect((await parseImportFile(IMPORT_TEMPLATE.filename, await serialize(file))).rows).toHaveLength(2000);
  });

  it.each(["headers", "order", "extra"])("does not identify a changed %s contract as the standard format", (change) => {
    const headers = [...templateHeaders];
    if (change === "headers") headers[0] = "다른 날짜 열";
    if (change === "order") [headers[0], headers[1]] = [headers[1], headers[0]];
    if (change === "extra") headers.push("추가 열");
    expect(matchesTemplateHeaders(headers)).toBe(false);
  });

  it.each(["=SUM(A1:A2)", "Sheet2!$A$1:$A$2", '"KRW,USD"+1', '"KRW,EUR"'])("rejects a changed dropdown expression %s before loading the workbook", async (formula) => {
    const file = await workbook();
    file.worksheets[0].getCell("B2").dataValidation = { type: "list", formulae: [formula] };
    file.worksheets[0].getRow(2).values = ["2025-01-02", "입금", "USD", "", "", "", "", "1000"];
    const encoded = await serialize(file);
    const load = vi.spyOn(Object.getPrototypeOf(new ExcelJS.Workbook().xlsx), "load");
    try {
      await expect(parseImportFile(IMPORT_TEMPLATE.filename, encoded)).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
      expect(load).not.toHaveBeenCalled();
    } finally { load.mockRestore(); }
  });
});
