import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import Decimal from "decimal.js";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { z } from "zod";
import { Prisma, type ImportJob } from "@prisma/client";
import { importFields, type ImportMapping, type ImportPreviewRow, type ImportUploadResult, type ImportValidationResult } from "../contracts";
import type { AssetInput, TransactionKind } from "../domain";
import { AppError } from "../errors";
import { dateString, transactionToDto } from "../serialization";
import { currencySchema, dateSchema, decimalSchema, idSchema, revisionSchema, transactionSchema } from "../validation";
import { createLedgerBatch, loadLedgerState, planLedgerBatch, withUserLedgerLock, type LedgerCreation, type LedgerState, type NewLedgerAsset } from "./ledger";

export const IMPORT_LIMITS = Object.freeze({
  bytes: 2 * 1024 * 1024, rows: 2000, columns: 40, headerLength: 128, cellLength: 4096,
  zipEntries: 256, zipEntryBytes: 8 * 1024 * 1024, zipExpandedBytes: 16 * 1024 * 1024,
});
const D = Decimal.clone({ precision: 80 });
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const invalidFile = (message: string) => new AppError(422, "INVALID_IMPORT_FILE", message);
const fieldSet = new Set<string>(importFields);
const reservedHeaderNames = new Set(["prototype", ...Object.getOwnPropertyNames(Object.prototype)].map((name) => name.toLowerCase()));
type RawRow = Record<string, string>;
type Changes = Record<string, RawRow>;
type Decisions = Record<string, "KEEP" | "SKIP">;
interface ParsedImport { format: "CSV" | "XLSX"; headers: string[]; rows: RawRow[] }

function tabularRows(matrix: string[][]): Pick<ParsedImport, "headers" | "rows"> {
  if (matrix.length < 2) throw invalidFile("헤더와 한 개 이상의 거래 행이 필요합니다.");
  if (matrix.length - 1 > IMPORT_LIMITS.rows) throw invalidFile("파일당 최대 2,000행까지 가져올 수 있습니다.");
  const headers = matrix[0].map((header) => header.trim().normalize("NFC"));
  if (headers.length > IMPORT_LIMITS.columns || headers.length === 0) throw invalidFile("파일은 최대 40열까지 지원합니다.");
  if (headers.some((header) => !header || header.length > IMPORT_LIMITS.headerLength || /[\u0000-\u001f\u007f]/.test(header) || header.split(".").some((part) => reservedHeaderNames.has(part.toLowerCase())))) {
    throw invalidFile("헤더는 비어 있지 않은 128자 이내의 안전한 이름이어야 합니다.");
  }
  if (new Set(headers.map((header) => header.toLocaleLowerCase("en-US"))).size !== headers.length) {
    throw invalidFile("중복된 열 이름은 사용할 수 없습니다.");
  }
  const rows = matrix.slice(1).map((values) => {
    if (values.length !== headers.length) throw invalidFile("모든 행의 열 수가 헤더와 일치해야 합니다.");
    if (values.some((value) => value.length > IMPORT_LIMITS.cellLength || value.includes("\u0000"))) {
      throw invalidFile("셀은 널 문자 없이 4,096자 이내여야 합니다.");
    }
    const row = Object.create(null) as RawRow;
    for (let index = 0; index < headers.length; index++) row[headers[index]] = values[index];
    return row;
  });
  return { headers, rows };
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidFile("UTF-8 인코딩 파일만 지원합니다.");
  }
}

function csvRows(bytes: Uint8Array): Pick<ParsedImport, "headers" | "rows"> {
  let rows: string[][];
  try {
    // Never let the CSV library turn untrusted headers into object properties.
    rows = parse(decodeUtf8(bytes), {
      bom: true, columns: false, relax_column_count: false, relax_quotes: false,
      skip_empty_lines: true, skip_records_with_error: false, cast: false,
      max_record_size: IMPORT_LIMITS.cellLength * IMPORT_LIMITS.columns + IMPORT_LIMITS.columns * 2,
      on_record: (record: string[], context: { records: number }) => {
        if (context.records > IMPORT_LIMITS.rows + 1) throw invalidFile("파일당 최대 2,000행까지 가져올 수 있습니다.");
        if (record.length > IMPORT_LIMITS.columns) throw invalidFile("파일은 최대 40열까지 지원합니다.");
        return record;
      },
    }) as string[][];
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidFile("CSV 따옴표, 구분자 또는 열 수가 올바르지 않습니다.");
  }
  return tabularRows(rows);
}

function openZip(bytes: Uint8Array): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    fromBuffer(Buffer.from(bytes), { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) reject(invalidFile("올바른 XLSX ZIP 파일이 아닙니다."));
      else resolve(zip);
    });
  });
}

function zipDirectory(zip: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    const names = new Set<string>();
    let expanded = 0;
    const fail = (error: Error) => { zip.close(); reject(error instanceof AppError ? error : invalidFile("XLSX ZIP 구조가 올바르지 않습니다.")); };
    zip.on("error", fail);
    zip.on("entry", (entry: Entry) => {
      if (names.has(entry.fileName)) return fail(invalidFile("XLSX에 중복된 ZIP 항목이 있습니다."));
      names.add(entry.fileName);
      expanded += entry.uncompressedSize;
      entries.push(entry);
      if (entries.length > IMPORT_LIMITS.zipEntries || entry.uncompressedSize > IMPORT_LIMITS.zipEntryBytes || expanded > IMPORT_LIMITS.zipExpandedBytes) {
        return fail(invalidFile("XLSX 압축 해제 크기 또는 항목 수 한도를 초과했습니다."));
      }
      if ((entry.generalPurposeBitFlag & 0x2041) !== 0 || ![0, 8].includes(entry.compressionMethod)) {
        return fail(invalidFile("암호화되거나 지원하지 않는 방식으로 압축된 XLSX는 사용할 수 없습니다."));
      }
      if (entry.fileName.includes("\\") || entry.fileName.startsWith("/") || entry.fileName.split("/").some((part) => part === ".." || part === ".")) {
        return fail(invalidFile("안전하지 않은 XLSX 파일 경로입니다."));
      }
      if (!entry.fileName.endsWith("/") && !/^(?:\[Content_Types\]\.xml|_rels\/\.rels|docProps\/(?:core|app|custom)\.xml|xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|styles\.xml|sharedStrings\.xml|theme\/theme\d+\.xml|worksheets\/sheet\d+\.xml|worksheets\/_rels\/sheet\d+\.xml\.rels))$/.test(entry.fileName)) {
        return fail(invalidFile("매크로, 외부 연결, 그림 또는 임베디드 개체가 없는 단일 시트 XLSX만 지원합니다."));
      }
      zip.readEntry();
    });
    zip.once("end", () => {
      const files = entries.map((entry) => entry.fileName);
      if (!files.includes("[Content_Types].xml") || !files.includes("xl/workbook.xml") || files.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).length !== 1) {
        return fail(invalidFile("단일 워크시트가 있는 XLSX 파일이 필요합니다."));
      }
      resolve(entries);
    });
    zip.readEntry();
  });
}

function zipContents(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(invalidFile("XLSX 항목을 읽을 수 없습니다."));
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > entry.uncompressedSize || size > IMPORT_LIMITS.zipEntryBytes) {
          stream.destroy(invalidFile("XLSX 압축 해제 크기가 선언된 한도를 초과했습니다."));
        } else chunks.push(chunk);
      });
      stream.once("error", () => reject(invalidFile("XLSX 압축 데이터가 올바르지 않습니다.")));
      stream.once("end", () => size === entry.uncompressedSize ? resolve(Buffer.concat(chunks)) : reject(invalidFile("XLSX 항목의 길이가 올바르지 않습니다.")));
    });
  });
}

function inspectXml(xml: string, name: string): void {
  if (/<!DOCTYPE|<!ENTITY|<\?xml[^>]*encoding\s*=\s*["'](?!utf-8["']|UTF-8["'])/i.test(xml)) {
    throw invalidFile("외부 엔터티 또는 UTF-8 이외의 XLSX XML은 사용할 수 없습니다.");
  }
  if (/<(?:[\w.-]+:)?(?:f|formula|formula1|formula2|definedName|externalReference|ddeLink|oleObject)\b|TargetMode\s*=\s*["']External["']|macroEnabled|vbaProject/i.test(xml)) {
    throw invalidFile("수식, 이름 정의, 매크로 또는 외부 참조를 포함한 XLSX는 사용할 수 없습니다.");
  }
  if (name === "xl/workbook.xml") {
    const sheets = [...xml.matchAll(/<(?:[\w.-]+:)?sheet\b([^>]*)>/g)];
    if (sheets.length !== 1 || /\bstate\s*=\s*["'](?:hidden|veryHidden)["']/i.test(sheets[0][1])) {
      throw invalidFile("숨겨지지 않은 단일 워크시트만 지원합니다.");
    }
  }
  if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) return;
  const columnNumber = (letters: string) => [...letters].reduce((result, letter) => result * 26 + letter.charCodeAt(0) - 64, 0);
  const boundedAddress = (address: string) => {
    const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address);
    return match && columnNumber(match[1]) <= IMPORT_LIMITS.columns && Number(match[2]) <= IMPORT_LIMITS.rows + 1;
  };
  const dimension = /<(?:[\w.-]+:)?dimension\b[^>]*\bref\s*=\s*["']([^"']+)["']/.exec(xml)?.[1];
  if (dimension && dimension.split(":").some((address) => !boundedAddress(address))) throw invalidFile("XLSX 시트 범위가 2,000행·40열 한도를 초과합니다.");
  if (/<(?:[\w.-]+:)?(?:mergeCell|sheetProtection)\b/.test(xml)) throw invalidFile("병합 또는 보호된 셀은 지원하지 않습니다.");
  const rowNumbers = new Set<string>();
  for (const row of xml.matchAll(/<(?:[\w.-]+:)?row\b([^>]*)>/g)) {
    const index = /\br\s*=\s*["']([^"']+)["']/.exec(row[1])?.[1];
    if (!index || !/^[1-9]\d{0,3}$/.test(index) || Number(index) > IMPORT_LIMITS.rows + 1 || rowNumbers.has(index)) {
      throw invalidFile("XLSX 행 번호가 중복되거나 지원 범위를 벗어났습니다.");
    }
    rowNumbers.add(index);
  }
  for (const column of xml.matchAll(/<(?:[\w.-]+:)?col\b([^>]*)>/g)) {
    for (const attribute of ["min", "max"]) {
      const index = new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']+)["']`).exec(column[1])?.[1];
      if (!index || !/^[1-9]\d?$/.test(index) || Number(index) > IMPORT_LIMITS.columns) throw invalidFile("XLSX 열 범위가 40열 한도를 초과합니다.");
    }
  }
  const addresses = new Set<string>();
  for (const cell of xml.matchAll(/<(?:[\w.-]+:)?c\b([^>]*)>/g)) {
    const address = /\br\s*=\s*["']([^"']+)["']/.exec(cell[1])?.[1];
    if (!address || !boundedAddress(address) || addresses.has(address)) throw invalidFile("XLSX 셀 주소가 중복되거나 지원 범위를 벗어났습니다.");
    addresses.add(address);
  }
  for (const cell of xml.matchAll(/<(?:[\w.-]+:)?c\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?c\s*>/g)) {
    const type = /\bt\s*=\s*["']([^"']+)["']/.exec(cell[1])?.[1];
    if (type && type !== "n") continue;
    const raw = /<(?:[\w.-]+:)?v(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?v\s*>/.exec(cell[2])?.[1];
    if (!raw) continue;
    if (!/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(Number(raw)) || !new D(raw).equals(new D(String(Number(raw))))) {
      throw invalidFile("정밀도가 손실되는 숫자 셀은 텍스트 형식으로 저장해 주세요.");
    }
  }
}

async function xlsxRows(bytes: Uint8Array): Promise<Pick<ParsedImport, "headers" | "rows">> {
  const zip = await openZip(bytes);
  try {
    // Inspect the complete central directory before decompressing XML or invoking ExcelJS.
    const entries = await zipDirectory(zip);
    for (const entry of entries) {
      if (!entry.fileName.endsWith("/")) inspectXml(decodeUtf8(await zipContents(zip, entry)), entry.fileName);
    }
  } finally {
    zip.close();
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(new Uint8Array(bytes).buffer);
  } catch {
    throw invalidFile("XLSX 통합 문서를 읽을 수 없습니다.");
  }
  if (workbook.worksheets.length !== 1) throw invalidFile("단일 워크시트만 지원합니다.");
  const sheet = workbook.worksheets[0];
  if (sheet.state !== "visible" || sheet.rowCount > IMPORT_LIMITS.rows + 1 || sheet.columnCount > IMPORT_LIMITS.columns || sheet.model.merges.length) {
    throw invalidFile("숨김·병합 셀 없이 최대 2,000행, 40열의 단일 시트가 필요합니다.");
  }
  const width = sheet.getRow(1).cellCount;
  if (!width || width > IMPORT_LIMITS.columns || sheet.columnCount > width) throw invalidFile("데이터와 일치하는 헤더가 필요합니다.");
  const matrix: string[][] = [];
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (row.hidden) throw invalidFile("숨겨진 행은 지원하지 않습니다.");
    const values: string[] = [];
    for (let column = 1; column <= width; column++) {
      if (sheet.getColumn(column).hidden) throw invalidFile("숨겨진 열은 지원하지 않습니다.");
      const value = row.getCell(column).value;
      if (value == null) values.push("");
      else if (typeof value === "string") values.push(value);
      else if (value instanceof Date && Number.isFinite(value.getTime()) && value.toISOString().endsWith("T00:00:00.000Z")) values.push(dateString(value));
      else if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) values.push(new D(String(value)).toFixed());
      else throw invalidFile("셀은 일반 텍스트, 안전한 숫자 또는 시간 없는 날짜여야 합니다. 수식과 복합 셀은 지원하지 않습니다.");
    }
    matrix.push(values);
  }
  return tabularRows(matrix);
}

export async function parseImportFile(filename: string, bytes: Uint8Array): Promise<ParsedImport> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > IMPORT_LIMITS.bytes) throw invalidFile("비어 있지 않은 2MiB 이하의 파일이 필요합니다.");
  if (!filename || filename.length > 200 || /[\\/\u0000-\u001f\u007f]/.test(filename)) throw invalidFile("올바른 200자 이내 파일 이름이 필요합니다.");
  if (/\.csv$/i.test(filename)) return { format: "CSV", ...csvRows(bytes) };
  if (/\.xlsx$/i.test(filename)) return { format: "XLSX", ...await xlsxRows(bytes) };
  throw invalidFile("UTF-8 CSV 또는 매크로 없는 XLSX 파일만 지원합니다.");
}

export function normalizeImportDate(value: string): string {
  const raw = value.trim();
  const separated = /^(\d{4})([-/.])(\d{2})\2(\d{2})$/.exec(raw);
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  const normalized = separated ? `${separated[1]}-${separated[3]}-${separated[4]}` : compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : raw;
  return dateSchema.parse(normalized);
}

export function normalizeImportDecimal(value: string): string {
  let raw = value.trim();
  if (raw.includes(",")) {
    if (!/^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d{1,12})?$/.test(raw)) throw new AppError(422, "AMBIGUOUS_NUMBER", "쉼표는 세 자리 단위의 천 단위 구분에만 사용할 수 있습니다.");
    raw = raw.replaceAll(",", "");
  }
  if (!/^\d+(?:\.\d{1,12})?$/.test(raw)) throw new AppError(422, "INVALID_NUMBER", "양의 십진수 문자열을 입력해 주세요. 지수·수식·소수 쉼표는 지원하지 않습니다.");
  return decimalSchema.parse(raw.replace(/^0+(?=\d)/, ""));
}

const kindLabels: Record<string, TransactionKind> = {
  매수: "BUY", 주식매수: "BUY", 매도: "SELL", 주식매도: "SELL",
  입금: "DEPOSIT", 예수금입금: "DEPOSIT", 출금: "WITHDRAWAL",
  배당: "DIVIDEND", 배당금: "DIVIDEND", 배당입금: "DIVIDEND",
  이자: "INTEREST", 이자입금: "INTEREST", 수수료: "FEE", 세금: "TAX", 제세금: "TAX",
  환전: "FX", 이체: "TRANSFER", 계좌이체: "TRANSFER", 분할: "SPLIT", 주식분할: "SPLIT",
  액면분할: "SPLIT", 병합: "SPLIT", 액면병합: "SPLIT", 평가: "VALUATION", 가격평가: "VALUATION",
};
export function normalizeImportKind(value: string): TransactionKind {
  const raw = value.trim().toUpperCase();
  const result = kindLabels[raw] ?? raw;
  return z.enum(["BUY", "SELL", "DEPOSIT", "WITHDRAWAL", "DIVIDEND", "INTEREST", "FEE", "TAX", "FX", "TRANSFER", "SPLIT", "VALUATION"]).parse(result);
}

const validationInputSchema = z.object({
  mapping: z.record(z.string().max(40), z.string().min(1).max(IMPORT_LIMITS.headerLength)),
  changes: z.record(z.string().max(4), z.record(z.string().max(40), z.string().max(IMPORT_LIMITS.cellLength))).optional(),
  decisions: z.record(z.string().max(4), z.enum(["KEEP", "SKIP"])).optional(),
  revision: revisionSchema,
}).strict();
interface StoredValidation {
  mapping: ImportMapping;
  changes: Changes;
  decisions: Decisions;
  ledgerVersion: number;
  result: ImportValidationResult;
  confirmation?: { created: number; skipped: number };
}

function jobRows(job: ImportJob): RawRow[] {
  return z.array(z.record(z.string(), z.string())).min(1).max(IMPORT_LIMITS.rows).parse(job.rows);
}

function jobHeaders(job: ImportJob): string[] {
  return z.array(z.string().min(1).max(IMPORT_LIMITS.headerLength)).min(1).max(IMPORT_LIMITS.columns).parse(job.headers);
}

function storedValidation(job: ImportJob): StoredValidation | null {
  return job.validated === null ? null : job.validated as unknown as StoredValidation;
}

function validateMapping(mapping: Record<string, string>, headers: string[], changes: Changes, decisions: Decisions, rowCount: number): asserts mapping is ImportMapping {
  const selected = new Set<string>();
  for (const [field, header] of Object.entries(mapping)) {
    if (!fieldSet.has(field) || !headers.includes(header) || selected.has(header)) {
      throw new AppError(422, "IMPORT_MAPPING", "매핑은 지원하는 필드와 서로 다른 원본 열 이름만 사용할 수 있습니다.");
    }
    selected.add(header);
  }
  for (const record of [changes, decisions]) {
    if (Object.keys(record).length > rowCount || Object.keys(record).some((key) => !/^[1-9]\d{0,3}$/.test(key) || Number(key) < 2 || Number(key) > rowCount + 1)) {
      throw new AppError(422, "IMPORT_ROW", "행 번호는 첫 데이터 행인 2부터 시작하는 실제 행 번호여야 합니다.");
    }
  }
  for (const patch of Object.values(changes)) {
    if (Object.keys(patch).some((field) => !fieldSet.has(field))) throw new AppError(422, "IMPORT_FIELD", "수정에는 원본 열 이름이 아닌 지원하는 표준 필드 이름을 사용해 주세요.");
  }
}

function mappingKey(mapping: ImportMapping): string {
  return JSON.stringify(importFields.map((field) => mapping[field] ?? null));
}

function fuzzyKey(row: {
  accountId: string; date: string; kind: string; currency: string; assetId?: string | null;
  quantity?: string | null; price?: string | null; amount?: string | null; toAccountId?: string | null;
  toCurrency?: string | null; toAmount?: string | null; ratio?: string | null;
}): string {
  const values = [row.accountId, row.date, row.kind, row.currency, row.assetId ?? ""];
  if (row.kind === "BUY" || row.kind === "SELL") values.push(row.quantity ?? "0", row.price ?? "0");
  else if (row.kind === "SPLIT") values.push(row.ratio ?? "0");
  else if (row.kind === "VALUATION") values.push(row.price ?? "0");
  else if (row.kind === "TRANSFER") values.push(row.toAccountId ?? "", row.assetId ? row.quantity ?? "0" : row.amount ?? "0");
  else if (row.kind === "FX") values.push(row.amount ?? "0", row.toCurrency ?? "", row.toAmount ?? "0");
  else values.push(row.amount ?? "0");
  return hash(JSON.stringify(values));
}

function sourceKey(accountId: string, fileHash: string, rowNumber: number, sourceTransactionId: string): string {
  return sourceTransactionId
    ? `source:${hash(JSON.stringify([accountId, sourceTransactionId]))}`
    : `row:${hash(JSON.stringify([accountId, fileHash, rowNumber]))}`;
}

function normalizeRow(
  raw: RawRow, mapping: ImportMapping, patch: RawRow, accountId: string, userId: string,
  assetsByKey: Map<string, AssetInput>, proposedAssets: Map<string, NewLedgerAsset>,
) {
  const values: RawRow = Object.fromEntries(importFields.map((field) => [field, mapping[field] ? raw[mapping[field]!] ?? "" : ""]));
  Object.assign(values, patch);
  const errors: ImportPreviewRow["errors"] = [];
  const normalize = (field: string, fn: (value: string) => string) => {
    try {
      values[field] = fn(values[field]);
    } catch (error) {
      if (error instanceof z.ZodError) errors.push({ field, message: error.issues[0]?.message ?? "값이 올바르지 않습니다." });
      else if (error instanceof AppError) errors.push({ field, message: error.message });
      else throw error;
    }
  };
  normalize("date", normalizeImportDate);
  normalize("kind", normalizeImportKind);
  normalize("currency", (value) => currencySchema.parse(value.trim().toUpperCase()));
  if (values.toCurrency.trim()) normalize("toCurrency", (value) => currencySchema.parse(value.trim().toUpperCase()));
  else values.toCurrency = "";
  for (const field of ["quantity", "price", "amount", "toAmount", "ratio"]) {
    if (values[field].trim()) normalize(field, normalizeImportDecimal);
    else values[field] = "";
  }
  for (const field of ["fee", "tax"]) normalize(field, (value) => value.trim() ? normalizeImportDecimal(value) : "0");
  if (["BUY", "SELL"].includes(values.kind) && values.amount && values.quantity && values.price &&
    !errors.some((error) => ["amount", "quantity", "price"].includes(error.field)) && !new D(values.amount).isZero()) {
    if (!new D(values.amount).equals(new D(values.quantity).times(values.price))) {
      errors.push({ field: "amount", message: "매수·매도 금액은 수량 × 단가의 총액과 일치해야 합니다. 순액 열은 매핑하지 않거나 이 행의 금액을 비워 주세요." });
    } else {
      // A verified statement gross total is redundant in the canonical ledger; the raw row retains it.
      values.amount = "";
    }
  }
  values.symbol = values.symbol.trim().toUpperCase();
  values.exchange = values.exchange.trim().toUpperCase();
  values.toAccountId = values.toAccountId.trim();
  values.sourceTransactionId = values.sourceTransactionId.trim();
  if (values.sourceTransactionId.length > 128 || /[\u0000-\u001f\u007f]/.test(values.sourceTransactionId)) {
    errors.push({ field: "sourceTransactionId", message: "원본 거래 ID는 제어 문자 없는 128자 이내여야 합니다." });
  }
  const tags = values.tags.split(/[,;|]/).map((tag) => tag.trim()).filter(Boolean);
  values.tags = tags.join(", ");
  let assetId: string | null = null;
  let proposed: { key: string; asset: NewLedgerAsset } | null = null;
  if (values.symbol || values.exchange) {
    if (!/^[\p{L}\p{N}^][\p{L}\p{N}_.:^/-]{0,31}$/u.test(values.symbol)) errors.push({ field: "symbol", message: "종목 코드는 32자 이내여야 합니다." });
    if (!/^[A-Z0-9][A-Z0-9_.-]{0,39}$/.test(values.exchange)) errors.push({ field: "exchange", message: "종목 거래에는 명시적인 거래소가 필요합니다." });
    const assetKey = `${values.symbol}\u0000${values.exchange}`;
    const existing = assetsByKey.get(assetKey) ?? proposedAssets.get(assetKey);
    if (existing) {
      assetId = existing.id;
      if (existing.currency !== values.currency) errors.push({ field: "currency", message: "기존 종목의 통화와 일치하지 않습니다." });
    } else if (values.kind === "VALUATION") {
      errors.push({ field: "symbol", message: "가격 평가에는 미리 등록한 사용자 정의(CUSTOM) 자산을 선택해 주세요." });
    } else if (!errors.some((error) => ["symbol", "exchange", "currency"].includes(error.field))) {
      // Generic imports have no asset-class column: new securities explicitly default to STOCK.
      const asset: NewLedgerAsset = {
        id: `import-asset:${hash(JSON.stringify([userId, values.symbol, values.exchange])).slice(0, 40)}`,
        symbol: values.symbol, name: values.symbol, exchange: values.exchange,
        currency: currencySchema.parse(values.currency), assetClass: "STOCK", country: null, sector: null, provider: "MANUAL",
      };
      proposed = { key: assetKey, asset };
      assetId = asset.id;
    }
  } else if (["BUY", "SELL", "DIVIDEND", "SPLIT", "VALUATION"].includes(values.kind)) {
    errors.push({ field: "symbol", message: "종목 코드와 거래소가 필요합니다." });
  }
  const parsed = transactionSchema.safeParse({
    accountId, date: values.date, kind: values.kind, currency: values.currency, assetId,
    quantity: values.quantity || null, price: values.price || null, amount: values.amount || null,
    fee: values.fee, tax: values.tax, toAccountId: values.toAccountId || null,
    toCurrency: values.toCurrency || null, toAmount: values.toAmount || null, ratio: values.ratio || null,
    memo: values.memo, tags,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? "row");
      if (!errors.some((error) => error.field === field)) errors.push({ field, message: issue.message });
    }
  }
  return { values, errors, input: parsed.success ? parsed.data : null, proposed };
}

function buildPreview(state: LedgerState, job: ImportJob, mapping: ImportMapping, changes: Changes, decisions: Decisions, revision: number) {
  const raws = jobRows(job);
  const assetsByKey = new Map<string, AssetInput>(state.assets.map((asset) => [`${asset.symbol.toUpperCase()}\u0000${asset.exchange.toUpperCase()}`, asset]));
  const proposedAssets = new Map<string, NewLedgerAsset>();
  const seenSources = new Set(state.transactions.map((row) => row.original.sourceKey));
  const possible = new Set(state.transactions.filter((row) => !row.deletedAt && row.original.importJobId !== job.id).map((row) => fuzzyKey(transactionToDto(row))));
  const rows: ImportPreviewRow[] = [];
  const creations: LedgerCreation[] = [];
  const rowById = new Map<string, ImportPreviewRow>();
  for (let index = 0; index < raws.length; index++) {
    const rowNumber = index + 2;
    const normalized = normalizeRow(raws[index], mapping, changes[String(rowNumber)] ?? {}, job.accountId, state.userId, assetsByKey, proposedAssets);
    const key = sourceKey(job.accountId, job.fileHash, rowNumber, normalized.values.sourceTransactionId);
    const duplicate = seenSources.has(key) ? "EXACT" : normalized.input && possible.has(fuzzyKey(normalized.input)) ? "POSSIBLE" : "NONE";
    const decision: ImportPreviewRow["decision"] = duplicate === "EXACT" ? "SKIP"
      : Object.hasOwn(decisions, String(rowNumber)) ? decisions[String(rowNumber)]
        : duplicate === "POSSIBLE" ? "UNDECIDED" : "KEEP";
    const row: ImportPreviewRow = { rowNumber, values: normalized.values, errors: normalized.errors, duplicate, decision };
    if (decision === "UNDECIDED") row.errors.push({ field: "duplicate", message: "유사한 기존 거래가 있습니다. KEEP 또는 SKIP을 명시적으로 선택해 주세요." });
    rows.push(row);
    if (decision === "KEEP") seenSources.add(key);
    if (decision === "KEEP" && normalized.input && !row.errors.length) {
      if (normalized.proposed) proposedAssets.set(normalized.proposed.key, normalized.proposed.asset);
      const id = `import:${hash(JSON.stringify([job.id, rowNumber])).slice(0, 48)}`;
      rowById.set(id, row);
      creations.push({
        id, input: normalized.input,
        original: {
          source: job.format, sourceKey: key, sourceTransactionId: normalized.values.sourceTransactionId || null,
          importJobId: job.id, rowNumber, rawData: raws[index],
        },
      });
    }
  }
  const referencedAssets = new Set(creations.map((creation) => creation.input.assetId));
  const assets = [...proposedAssets.values()].filter((asset) => referencedAssets.has(asset.id));
  const plan = planLedgerBatch(state, creations, assets);
  for (const issue of plan.issues.filter((issue) => issue.severity === "error")) {
    const target = issue.transactionId ? rowById.get(issue.transactionId) : undefined;
    const affected = target ? [target] : rows.filter((row) => row.decision === "KEEP");
    for (const row of affected) {
      if (!row.errors.some((error) => error.field === "ledger" && error.message === issue.message)) row.errors.push({ field: "ledger", message: issue.message });
    }
  }
  const errors = rows.filter((row) => row.decision !== "SKIP" && row.errors.length > 0).length;
  const result: ImportValidationResult = {
    jobId: job.id, revision, rows, valid: errors === 0 && rows.every((row) => row.decision !== "UNDECIDED"),
    summary: { total: rows.length, keep: rows.filter((row) => row.decision === "KEEP").length, skip: rows.filter((row) => row.decision === "SKIP").length, errors },
  };
  return { result, creations, assets };
}

function uploadResult(job: ImportJob, duplicateFile: boolean): ImportUploadResult {
  return { jobId: job.id, filename: job.filename, headers: jobHeaders(job), rows: jobRows(job), status: job.status, duplicateFile, revision: job.revision };
}

export async function uploadImport(userId: string, accountId: string, filename: string, bytes: Uint8Array): Promise<ImportUploadResult> {
  idSchema.parse(accountId);
  const parsed = await parseImportFile(filename, bytes);
  const fileHash = hash(bytes);
  return withUserLedgerLock(userId, async (tx) => {
    const account = await tx.brokerAccount.findFirst({ where: { id: accountId, userId }, select: { id: true } });
    if (!account) throw new AppError(404, "NOT_FOUND", "계좌를 찾을 수 없습니다.");
    const existing = await tx.importJob.findFirst({ where: { userId, accountId, fileHash } });
    if (existing) return uploadResult(existing, true);
    const job = await tx.importJob.create({ data: { userId, accountId, filename, fileHash, format: parsed.format, headers: parsed.headers, rows: parsed.rows } });
    return uploadResult(job, false);
  });
}

export async function validateImport(
  userId: string, jobId: string,
  input: { mapping: ImportMapping; changes?: Record<string, Record<string, string>>; decisions?: Record<string, "KEEP" | "SKIP">; revision: number },
): Promise<ImportValidationResult> {
  idSchema.parse(jobId);
  const parsed = validationInputSchema.parse(input);
  return withUserLedgerLock(userId, async (tx) => {
    const job = await tx.importJob.findFirst({ where: { id: jobId, userId } });
    if (!job) throw new AppError(404, "NOT_FOUND", "가져오기 작업을 찾을 수 없습니다.");
    if (job.status === "CONFIRMED") throw new AppError(409, "IMPORT_CONFIRMED", "확정된 가져오기의 매핑과 원본은 변경할 수 없습니다.");
    if (job.revision !== parsed.revision) throw new AppError(409, "REVISION_CONFLICT", "미리보기가 변경되었습니다. 새로고침해 주세요.");
    const state = await loadLedgerState(tx, userId);
    if (!state.accounts.some((account) => account.id === job.accountId)) throw new AppError(404, "NOT_FOUND", "계좌를 찾을 수 없습니다.");
    const previous = storedValidation(job);
    const sameMapping = previous && mappingKey(previous.mapping) === mappingKey(parsed.mapping as ImportMapping);
    const changes: Changes = sameMapping ? { ...previous.changes } : {};
    const decisions: Decisions = sameMapping ? { ...previous.decisions } : {};
    for (const [row, patch] of Object.entries(parsed.changes ?? {})) {
      if (JSON.stringify(changes[row]) !== JSON.stringify({ ...changes[row], ...patch })) delete decisions[row];
      changes[row] = { ...changes[row], ...patch };
    }
    Object.assign(decisions, parsed.decisions ?? {});
    validateMapping(parsed.mapping, jobHeaders(job), changes, decisions, jobRows(job).length);
    let built = buildPreview(state, job, parsed.mapping, changes, decisions, job.revision + 1);
    const oldRows = new Map(previous?.result.rows.map((row) => [row.rowNumber, row]) ?? []);
    let decisionExpired = false;
    for (const row of built.result.rows) {
      if (row.duplicate === "POSSIBLE" && row.decision === "KEEP" && oldRows.get(row.rowNumber)?.duplicate !== "POSSIBLE" && !Object.hasOwn(parsed.decisions ?? {}, String(row.rowNumber))) {
        delete decisions[String(row.rowNumber)];
        decisionExpired = true;
      }
    }
    if (decisionExpired) built = buildPreview(state, job, parsed.mapping, changes, decisions, job.revision + 1);
    const stored: StoredValidation = { mapping: parsed.mapping, changes, decisions, ledgerVersion: state.ledgerVersion, result: built.result };
    const updated = await tx.importJob.updateMany({
      where: { id: jobId, userId, revision: parsed.revision, status: { not: "CONFIRMED" } },
      data: { status: "VALIDATED", mapping: parsed.mapping, validated: stored as unknown as Prisma.InputJsonValue, revision: { increment: 1 } },
    });
    if (updated.count !== 1) throw new AppError(409, "REVISION_CONFLICT", "미리보기가 동시에 변경되었습니다.");
    return built.result;
  });
}

export async function confirmImport(userId: string, jobId: string, revision: number): Promise<{ created: number; skipped: number; alreadyConfirmed: boolean }> {
  idSchema.parse(jobId);
  revisionSchema.parse(revision);
  return withUserLedgerLock(userId, async (tx) => {
    const job = await tx.importJob.findFirst({ where: { id: jobId, userId } });
    if (!job) throw new AppError(404, "NOT_FOUND", "가져오기 작업을 찾을 수 없습니다.");
    const state = await loadLedgerState(tx, userId);
    if (!state.accounts.some((account) => account.id === job.accountId)) throw new AppError(404, "NOT_FOUND", "계좌를 찾을 수 없습니다.");
    const previous = storedValidation(job);
    if (job.status === "CONFIRMED") {
      if (!previous?.confirmation) throw new AppError(409, "IMPORT_STATE", "확정된 가져오기 결과를 찾을 수 없습니다.");
      return { ...previous.confirmation, alreadyConfirmed: true };
    }
    if (job.revision !== revision) throw new AppError(409, "REVISION_CONFLICT", "미리보기가 변경되었습니다. 다시 확인해 주세요.");
    if (job.status !== "VALIDATED" || !previous?.result.valid) throw new AppError(422, "IMPORT_NOT_VALIDATED", "모든 행의 오류와 중복 결정을 확인한 후 확정해 주세요.");
    validateMapping(previous.mapping as Record<string, string>, jobHeaders(job), previous.changes, previous.decisions, jobRows(job).length);
    const built = buildPreview(state, job, previous.mapping, previous.changes, previous.decisions, job.revision + 1);
    const previousRows = new Map(previous.result.rows.map((row) => [row.rowNumber, row]));
    for (const row of built.result.rows) {
      if (row.duplicate === "POSSIBLE" && row.decision !== "SKIP" && previousRows.get(row.rowNumber)?.duplicate !== "POSSIBLE") {
        row.decision = "UNDECIDED";
        if (!row.errors.some((error) => error.field === "duplicate")) row.errors.push({ field: "duplicate", message: "미리보기 이후 유사 거래가 추가되었습니다. 중복 여부를 다시 확인해 주세요." });
        built.result.valid = false;
      }
    }
    built.result.summary.keep = built.result.rows.filter((row) => row.decision === "KEEP").length;
    built.result.summary.errors = built.result.rows.filter((row) => row.decision !== "SKIP" && row.errors.length).length;
    if (!built.result.valid) throw new AppError(422, "IMPORT_VALIDATION_FAILED", "원장 변경으로 미리보기가 더 이상 유효하지 않습니다. 다시 검증해 주세요.", built.result);
    const created = await createLedgerBatch(tx, state, built.creations, built.assets);
    const confirmation = { created: created.length, skipped: built.result.summary.skip };
    const stored: StoredValidation = { ...previous, ledgerVersion: state.ledgerVersion + (created.length ? 1 : 0), result: built.result, confirmation };
    const updated = await tx.importJob.updateMany({
      where: { id: jobId, userId, revision, status: "VALIDATED" },
      data: { status: "CONFIRMED", confirmedAt: new Date(), revision: { increment: 1 }, validated: stored as unknown as Prisma.InputJsonValue },
    });
    if (updated.count !== 1) throw new AppError(409, "REVISION_CONFLICT", "가져오기가 동시에 변경되었습니다.");
    return { ...confirmation, alreadyConfirmed: false };
  });
}
