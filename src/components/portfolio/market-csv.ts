import { parse } from "csv-parse/browser/esm/sync";
import Decimal from "decimal.js";
import type { AssetDto } from "@/lib/contracts";
import type { Currency } from "@/lib/domain";
import { today } from "./format";

export type MarketCsvKind = "PRICE" | "FX";
export interface MarketCsvRow {
  rowNumber: number;
  values: Record<string, string>;
  assetName?: string;
  errors: string[];
}
type PriceRow = { assetId: string; date: string; close: string; currency: Currency };
type FxRow = { date: string; base: Currency; quote: Currency; rate: string };
export interface MarketCsvPreview {
  rows: MarketCsvRow[];
  payload: (PriceRow | FxRow)[];
  invalid: number;
}

const aliases = new Map<string, string>(Object.entries({
  date: "date", 날짜: "date", 일자: "date", 기준일: "date",
  symbol: "symbol", ticker: "symbol", 종목코드: "symbol",
  exchange: "exchange", 거래소: "exchange",
  close: "close", 종가: "close",
  currency: "currency", 통화: "currency",
  assetid: "assetId",
  base: "base", 기준통화: "base",
  quote: "quote", 상대통화: "quote", 대상통화: "quote",
  rate: "rate", 환율: "rate",
}));
const isCurrency = (value: string): value is Currency => value === "KRW" || value === "USD";

function dateValue(value: string, errors: string[]) {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  const result = match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : value;
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result || result < "1900-01-01" || result > today()) {
    errors.push("날짜: 오늘 이전의 유효한 YYYY-MM-DD 날짜를 입력하세요.");
  }
  return result;
}

function decimalValue(value: string, label: string, errors: string[]) {
  let normalized = value;
  if (/^\d{1,3}(,\d{3})+(?:\.\d+)?$/.test(normalized)) normalized = normalized.replaceAll(",", "");
  if (/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) {
    const decimal = new Decimal(normalized);
    if (decimal.isFinite() && decimal.gt(0) && decimal.e <= 16 && decimal.decimalPlaces() <= 12) {
      const canonical = decimal.toFixed();
      if (/^(?:0|[1-9]\d{0,16})(?:\.\d{1,12})?$/.test(canonical)) return canonical;
    }
  }
  errors.push(`${label}: 0보다 큰 숫자가 필요합니다. 정수 17자리, 소수 12자리 이내로 입력하세요.`);
  return value;
}

export function parseMarketCsv(source: string, kind: MarketCsvKind, assets: AssetDto[]): MarketCsvPreview {
  if (new TextEncoder().encode(source).byteLength > 2 * 1024 * 1024) throw new Error("CSV 파일은 2 MiB 이하여야 합니다.");
  const allowed = kind === "PRICE" ? ["date", "symbol", "exchange", "assetId", "close", "currency"] : ["date", "base", "quote", "rate"];
  let parsed: string[][];
  try {
    parsed = parse(source, {
      bom: true, trim: true, skip_empty_lines: true, max_record_size: 2 * 1024 * 1024,
      columns: false,
    }) as string[][];
  } catch (cause) {
    if (cause instanceof Error && /[가-힣]/.test(cause.message)) throw cause;
    const line = cause && typeof cause === "object" && "lines" in cause ? ` ${String(cause.lines)}행` : "";
    throw new Error(`CSV${line} 형식을 확인해 주세요. 쉼표가 든 값은 따옴표로 감싸고 각 행의 열 개수를 맞춰 주세요.`);
  }
  if (!parsed.length) throw new Error("CSV 헤더 아래에 가격 또는 환율 데이터를 입력해 주세요.");
  const headers = parsed[0].map((header) => {
    const name = header.trim().replace(/[\s_]+/g, "").toLowerCase();
    if (["proto", "prototype", "constructor"].includes(name)) throw new Error("안전하지 않은 CSV 열 이름입니다. __proto__, prototype, constructor는 사용할 수 없습니다.");
    const canonical = aliases.get(name);
    if (!canonical || !allowed.includes(canonical)) throw new Error(`지원하지 않는 열이 있습니다. 필요한 열: ${allowed.filter((field) => field !== "assetId").join(", ")}.${kind === "PRICE" ? " 조정종가가 아닌 원시 종가(close)만 지원합니다." : ""}`);
    return canonical;
  });
  if (new Set(headers).size !== headers.length) throw new Error("CSV 열 이름이 중복되어 있습니다.");
  const required = kind === "PRICE" ? ["date", "close", "currency"] : allowed;
  if (required.some((field) => !headers.includes(field)) || (kind === "PRICE" && !headers.includes("assetId") && (!headers.includes("symbol") || !headers.includes("exchange")))) {
    throw new Error(`필수 열이 없습니다. CSV 양식의 ${allowed.filter((field) => field !== "assetId").join(", ")} 열을 확인해 주세요.`);
  }
  const records = parsed.slice(1);
  if (!records.length) throw new Error("CSV 헤더 아래에 가격 또는 환율 데이터를 입력해 주세요.");
  if (records.length > 2000) throw new Error(`CSV 데이터는 최대 2,000행입니다. 현재 ${records.length.toLocaleString("ko-KR")}행입니다.`);
  const seen = new Set<string>();
  const payload: MarketCsvPreview["payload"] = [];
  const rows = records.map((record, index): MarketCsvRow => {
    const errors: string[] = [];
    if (record.length !== headers.length) throw new Error(`CSV ${index + 2}행의 열 개수가 헤더와 다릅니다.`);
    const values: Record<string, string> = Object.create(null);
    headers.forEach((header, column) => { values[header] = record[column].trim(); });
    values.date = dateValue(values.date ?? "", errors);
    let assetName: string | undefined;
    let key = "";
    if (kind === "PRICE") {
      values.symbol = (values.symbol ?? "").toUpperCase();
      values.exchange = (values.exchange ?? "").toUpperCase();
      values.currency = (values.currency ?? "").toUpperCase();
      values.close = decimalValue(values.close ?? "", "종가", errors);
      if (!isCurrency(values.currency)) errors.push("통화: KRW 또는 USD를 입력하세요.");
      const matches = values.assetId
        ? assets.filter((asset) => asset.id === values.assetId)
        : assets.filter((asset) => asset.symbol.toUpperCase() === values.symbol && asset.exchange.toUpperCase() === values.exchange && asset.currency === values.currency);
      const asset = matches.length === 1 ? matches[0] : undefined;
      if (!asset) errors.push("종목: 코드·거래소·통화가 일치하는 종목을 설정 → 종목 관리에서 먼저 등록하세요.");
      if (asset) {
        assetName = asset.name;
        if (asset.currency !== values.currency) errors.push(`통화: 등록된 종목의 통화 ${asset.currency}와 일치해야 합니다.`);
        if ((values.symbol && values.symbol !== asset.symbol.toUpperCase()) || (values.exchange && values.exchange !== asset.exchange.toUpperCase())) errors.push("종목 코드·거래소가 등록된 종목과 다릅니다.");
        values.symbol = asset.symbol;
        values.exchange = asset.exchange;
        key = `${asset.id}:${values.date}`;
      }
      if (key && seen.has(key)) errors.push("중복: 같은 종목·날짜가 파일 안에 두 번 있습니다.");
      if (!errors.length && asset && isCurrency(values.currency)) payload.push({ assetId: asset.id, date: values.date, close: values.close, currency: values.currency });
    } else {
      values.base = (values.base ?? "").toUpperCase();
      values.quote = (values.quote ?? "").toUpperCase();
      values.rate = decimalValue(values.rate ?? "", "환율", errors);
      if (!isCurrency(values.base) || !isCurrency(values.quote)) errors.push("통화쌍: 기준·상대 통화는 KRW 또는 USD여야 합니다.");
      if (values.base === values.quote) errors.push("통화쌍: 기준 통화와 상대 통화는 달라야 합니다.");
      key = `${values.date}:${[values.base, values.quote].sort().join(":")}`;
      if (seen.has(key)) errors.push("중복: 같은 날짜의 통화쌍이 역방향을 포함해 두 번 있습니다.");
      if (!errors.length && isCurrency(values.base) && isCurrency(values.quote)) payload.push({ date: values.date, base: values.base, quote: values.quote, rate: values.rate });
    }
    if (key) seen.add(key);
    return { rowNumber: index + 2, values, assetName, errors };
  });
  return { rows, payload, invalid: rows.filter((row) => row.errors.length > 0).length };
}
