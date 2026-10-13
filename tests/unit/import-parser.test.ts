import { deflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMPORT_LIMITS, parseImportFile } from "../../src/lib/services/imports";

const utf8 = (value: string) => Buffer.from(value, "utf8");
afterEach(() => vi.restoreAllMocks());

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipFile(files: { name: string; content?: string; expandedSize?: number; encrypted?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = utf8(file.name);
    const raw = utf8(file.content ?? "");
    const compressed = deflateRawSync(raw);
    const checksum = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.encrypted ? 1 : 0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.expandedSize ?? raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(file.encrypted ? 1 : 0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.expandedSize ?? raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    directory.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

async function workbookBytes(edit?: (workbook: ExcelJS.Workbook, sheet: ExcelJS.Worksheet) => void): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("거래");
  sheet.addRow(["날짜", "종류", "금액", "메모"]);
  sheet.addRow([new Date("2024-02-29T00:00:00.000Z"), "입금", 1000.25, "added"]);
  edit?.(workbook, sheet);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

describe("bounded strict CSV parser", () => {
  it("preserves original quoted values, whitespace, Unicode and embedded newlines", async () => {
    const result = await parseImportFile("trades.CSV", utf8('\ufeff날짜,유형,금액,메모\r\n2024/02/29,입금,"1,234.50","  원본\n두 번째 줄  "\r\n'));
    expect(result.format).toBe("CSV");
    expect(result.headers).toEqual(["날짜", "유형", "금액", "메모"]);
    expect(result.rows).toEqual([{ 날짜: "2024/02/29", 유형: "입금", 금액: "1,234.50", 메모: "  원본\n두 번째 줄  " }]);
  });
  it.each([
    "a,b\n1\n", "a,b\n1,2,3\n", 'a,b\n"unclosed,1', 'a,b\nbad"quote,1', "a,a\n1,2",
    "date, DATE \n1,2", ",kind\n1,2", "__proto__,kind\n1,2", "a,b\n",
  ])("rejects malformed CSV %j", async (content) => {
    await expect(parseImportFile("bad.csv", utf8(content))).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
  });
  it("rejects unsupported encoding, names and null characters", async () => {
    await expect(parseImportFile("bad.csv", Uint8Array.from([0xff, 0xfe, 0, 0]))).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
    for (const name of ["data.xls", "data.xlsm", "../data.csv", "folder\\data.csv", "x".repeat(201) + ".csv"]) {
      await expect(parseImportFile(name, utf8("a\n1"))).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
    }
    await expect(parseImportFile("bad.csv", utf8("a\nnull\u0000data"))).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
  });
  it("enforces byte, row, column, header and cell limits", async () => {
    await expect(parseImportFile("big.csv", new Uint8Array(IMPORT_LIMITS.bytes + 1))).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
    await expect(parseImportFile("empty.csv", new Uint8Array())).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
    await expect(parseImportFile("rows.csv", utf8("a\n" + "1\n".repeat(2001)))).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
    expect((await parseImportFile("rows.csv", utf8("a\n" + "1\n".repeat(2000)))).rows).toHaveLength(2000);
    const headers = Array.from({ length: 41 }, (_, index) => `h${index}`).join(",");
    await expect(parseImportFile("cols.csv", utf8(`${headers}\n${headers}`))).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
    await expect(parseImportFile("header.csv", utf8(`${"h".repeat(129)}\n1`))).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
    await expect(parseImportFile("cell.csv", utf8(`h\n${"x".repeat(4097)}`))).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
  });
  it("does not evaluate CSV expressions", async () => {
    const parsed = await parseImportFile("literal.csv", utf8('date,memo\n2024-01-01,"=SUM(1,2)"'));
    expect(parsed.rows[0].memo).toBe("=SUM(1,2)");
  });
  it.each([
    "__proto__", " __PrOtO__ ", "constructor", "CONSTRUCTOR", "prototype", "Prototype",
    "toString", "valueOf", "hasOwnProperty", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
    "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "metadata.__proto__.polluted", "constructor.prototype",
  ])("rejects prototype-reserved CSV header %j", async (header) => {
    const originalKeys = Object.getOwnPropertyNames(Object.prototype);
    await expect(parseImportFile("prototype.csv", utf8(`${header},normal\npolluted,safe`))).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(originalKeys);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
  it("constructs prototype-free row dictionaries and preserves JSON-looking cell text literally", async () => {
    const parsed = await parseImportFile("literal-object.csv", utf8('name,memo\nsafe,"{""__proto__"":{""polluted"":true}}"'));
    expect(Object.getPrototypeOf(parsed.rows[0])).toBeNull();
    expect(parsed.rows[0].memo).toBe('{"__proto__":{"polluted":true}}');
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(JSON.parse(JSON.stringify(parsed.rows[0]))).toEqual({ name: "safe", memo: '{"__proto__":{"polluted":true}}' });
  });
});

describe("protected XLSX parser", () => {
  it("reads plain date, string and numeric cells without changing raw strings", async () => {
    const result = await parseImportFile("trades.xlsx", await workbookBytes());
    expect(result.format).toBe("XLSX");
    expect(result.rows).toEqual([{ 날짜: "2024-02-29", 종류: "입금", 금액: "1000.25", 메모: "added" }]);
  });

  it("rejects formulas before ExcelJS loads the workbook", async () => {
    const bytes = await workbookBytes((_, sheet) => { sheet.getCell("C2").value = { formula: "1+1", result: 2 }; });
    const load = vi.spyOn(Object.getPrototypeOf(new ExcelJS.Workbook().xlsx), "load");
    await expect(parseImportFile("formula.xlsx", bytes)).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
    expect(load).not.toHaveBeenCalled();
  });
  it.each(["__proto__", "CONSTRUCTOR", "toString", "metadata.__proto__.polluted"])("rejects prototype-reserved XLSX header %j", async (header) => {
    const bytes = await workbookBytes((_, sheet) => { sheet.getCell("A1").value = header; });
    await expect(parseImportFile("prototype.xlsx", bytes)).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it.each(["extra-sheet", "hidden-sheet", "hidden-row", "hidden-column", "merge", "wide", "tall", "rich-text", "time", "unsafe-number"])("rejects unsafe workbook shape %s", async (shape) => {
    const bytes = await workbookBytes((workbook, sheet) => {
      if (shape === "extra-sheet") workbook.addWorksheet("other").addRow(["a"]);
      if (shape === "hidden-sheet") sheet.state = "veryHidden";
      if (shape === "hidden-row") sheet.getRow(2).hidden = true;
      if (shape === "hidden-column") sheet.getColumn(3).hidden = true;
      if (shape === "merge") sheet.mergeCells("A2:B2");
      if (shape === "wide") sheet.getCell("AO2").value = "outside";
      if (shape === "tall") sheet.getCell("A2002").value = "outside";
      if (shape === "rich-text") sheet.getCell("D2").value = { richText: [{ text: "rich", font: { bold: true } }] };
      if (shape === "time") sheet.getCell("A2").value = new Date("2024-02-29T12:30:00.000Z");
      if (shape === "unsafe-number") sheet.getCell("C2").value = Number.MAX_SAFE_INTEGER + 1;
    });
    await expect(parseImportFile("unsafe.xlsx", bytes)).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
  });

  it.each([
    [{ name: "../escape.xml" }],
    [{ name: "xl/vbaProject.bin" }],
    [{ name: "xl/workbook.xml", encrypted: true }],
    [{ name: "xl/workbook.xml", expandedSize: IMPORT_LIMITS.zipEntryBytes + 1 }],
    [{ name: "xl/workbook.xml" }, { name: "xl/workbook.xml" }],
    [
      { name: "[Content_Types].xml", expandedSize: 6 * 1024 * 1024 },
      { name: "xl/workbook.xml", expandedSize: 6 * 1024 * 1024 },
      { name: "xl/worksheets/sheet1.xml", expandedSize: 6 * 1024 * 1024 },
    ],
    Array.from({ length: 257 }, (_, index) => ({ name: `directory-${index}/` })),
  ])("rejects unsafe ZIP metadata before workbook parsing", async (...files) => {
    const load = vi.spyOn(Object.getPrototypeOf(new ExcelJS.Workbook().xlsx), "load");
    await expect(parseImportFile("unsafe.xlsx", zipFile(files))).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    '<!DOCTYPE worksheet [<!ENTITY x SYSTEM "file:///secret">]><worksheet/>',
    '<worksheet><sheetData><row r="999999999"><c r="A999999999"><v>1</v></c></row></sheetData></worksheet>',
    '<worksheet><sheetData><row r="2"><c r="A2"><v>1.00000000000000001</v></c></row></sheetData></worksheet>',
    '<worksheet><sheetData><row r="2"><c r="A2"><v>1</v></c><c r="A2"><v>2</v></c></row></sheetData></worksheet>',
    '<worksheet><externalReference TargetMode="External"/></worksheet>',
    '<worksheet><conditionalFormatting><cfRule><formula>SUM(A1:A2)</formula></cfRule></conditionalFormatting></worksheet>',
    '<worksheet><dataValidations><dataValidation><formula1>SUM(A1:A2)</formula1></dataValidation></dataValidations></worksheet>',
    '<worksheet><dataValidations><dataValidation type="list" sqref="A1:XFD1048576"><formula1>"KRW,USD"</formula1></dataValidation></dataValidations></worksheet>',
    '<worksheet><dataValidations><dataValidation type="list" sqref="A2:A2002"><formula1>"KRW,USD"</formula1></dataValidation></dataValidations></worksheet>',
    '<worksheet><dataValidations><dataValidation type="list" sqref="A3:A2"><formula1>"KRW,USD"</formula1></dataValidation></dataValidations></worksheet>',
    '<worksheet><dataValidations><dataValidation type="list" sqref="A1:AN2001 A1:AN2001"><formula1>"KRW,USD"</formula1></dataValidation></dataValidations></worksheet>',
    '<worksheet><dataValidations><dataValidation type="textLength" operator="lessThanOrEqual" sqref="A2"><formula1>SUM(A1:A2)</formula1></dataValidation></dataValidations></worksheet>',
    '<worksheet><dataValidations><dataValidation type="list" sqref="A2" sqref="A1:XFD1048576"><formula1>"KRW,USD"</formula1></dataValidation></dataValidations></worksheet>',
    `<worksheet><dataValidations><dataValidation type="list" prompt='sqref="A2"' sqref="A1:XFD1048576"><formula1>"KRW,USD"</formula1></dataValidation></dataValidations></worksheet>`,
  ])("rejects unsafe XML before workbook parsing", async (content) => {
    const bytes = zipFile([
      { name: "[Content_Types].xml", content: "<Types/>" },
      { name: "xl/workbook.xml", content: '<workbook><sheets><sheet name="Trades" sheetId="1"/></sheets></workbook>' },
      { name: "xl/worksheets/sheet1.xml", content },
    ]);
    const load = vi.spyOn(Object.getPrototypeOf(new ExcelJS.Workbook().xlsx), "load");
    await expect(parseImportFile("unsafe.xlsx", bytes)).rejects.toMatchObject({ code: "INVALID_IMPORT_FILE" });
    expect(load).not.toHaveBeenCalled();
  });
});
