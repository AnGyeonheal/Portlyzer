import Decimal from "decimal.js";
import type { Currency, DataIssue, TransactionKind } from "@/lib/domain";

const DisplayDecimal = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_EVEN });

function displayDecimal(value: string | number | null | undefined): Decimal | null {
  if (value === null || value === undefined || value === "" || number(value) === null) return null;
  return new DisplayDecimal(value);
}

function exactFormat(value: Decimal, options: Intl.NumberFormatOptions): string {
  const maximum = options.maximumFractionDigits ?? 12;
  const minimum = options.minimumFractionDigits ?? 0;
  const fixed = value.toFixed(maximum);
  const [whole, decimals = ""] = fixed.split(".");
  const fraction = decimals.replace(/0+$/, "").padEnd(minimum, "0");
  const integer = BigInt(whole);
  const negativeFraction = fixed.startsWith("-") && integer === 0n;
  const formatter = new Intl.NumberFormat("ko-KR", { ...options, minimumFractionDigits: fraction.length });
  // BigInt preserves integral digits; replace only the localized fractional part.
  return formatter.formatToParts(negativeFraction ? -1n : integer).map((part) => {
    if (part.type === "fraction") return fraction;
    if (part.type === "integer" && negativeFraction) return "0";
    return part.value;
  }).join("");
}

export function number(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function money(value: string | number | null | undefined, currency: Currency = "KRW", compact = false): string {
  const parsed = displayDecimal(value);
  if (parsed === null) return "—";
  if (!compact) return exactFormat(parsed, {
    style: "currency", currency,
    minimumFractionDigits: currency === "KRW" ? 0 : 2,
    maximumFractionDigits: currency === "KRW" ? 0 : 2,
  });
  return new Intl.NumberFormat("ko-KR", {
    style: "currency", currency, notation: "compact", maximumFractionDigits: 1,
  }).format(parsed.toNumber());
}

export function percent(value: string | number | null | undefined, signed = false): string {
  const parsed = number(value);
  if (parsed === null) return "—";
  return new Intl.NumberFormat("ko-KR", {
    style: "percent", maximumFractionDigits: 2, minimumFractionDigits: 2,
    signDisplay: signed ? "exceptZero" : "auto",
  }).format(parsed);
}

export function quantity(value: string | number | null | undefined): string {
  const parsed = displayDecimal(value);
  if (parsed === null) return "—";
  if (!parsed.isZero() && parsed.abs().lt("0.000000000001")) return parsed.toString();
  return exactFormat(parsed, { maximumFractionDigits: 12 });
}

export function unitMoney(value: string | number | null | undefined, currency: Currency = "KRW"): string {
  const parsed = displayDecimal(value);
  return parsed === null ? "—" : exactFormat(parsed, {
    style: "currency", currency, maximumFractionDigits: 12, minimumFractionDigits: currency === "USD" ? 2 : 0,
  });
}

export function sum(values: (string | null | undefined)[]): string | null {
  if (values.some((value) => value === null || value === undefined)) return null;
  return values.reduce<Decimal>((total, value) => total.plus(value || "0"), new DisplayDecimal(0)).toString();
}

export function tone(value: string | number | null | undefined) {
  const parsed = number(value);
  return parsed === null || parsed === 0 ? "text-muted" : parsed > 0 ? "text-positive" : "text-negative";
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function dateTime(value: string | null | undefined) {
  if (!value) return "수집 정보 없음";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const kindLabels: Record<TransactionKind, string> = {
  BUY: "매수", SELL: "매도", DEPOSIT: "입금", WITHDRAWAL: "출금", DIVIDEND: "배당",
  INTEREST: "이자", FEE: "수수료", TAX: "세금", FX: "환전", TRANSFER: "계좌 이체",
  SPLIT: "주식 분할", VALUATION: "사용자 자산 평가",
};
export const assetClassLabels: Record<string, string> = { STOCK: "주식", ETF: "ETF", CRYPTO: "가상자산", CUSTOM: "사용자 자산", CASH: "현금" };
export const accountTypeLabels: Record<string, string> = { GENERAL: "일반", ISA: "ISA", PENSION: "연금" };
export const colors = ["#0e8074", "#173e58", "#69b6a5", "#e5b86a", "#8b9db9", "#cd8e81", "#a2b6a1", "#b2a1c9"];

const issueLabels: Record<string, string> = {
  MISSING_PRICE: "계산일 또는 그 이전의 가격 관측치가 없습니다. 해당 종목의 종가를 등록해 주세요.",
  STALE_PRICE: "최근 가격이 허용된 사용 기간을 넘었습니다. 최신 가격이 없어 평가할 수 없습니다.",
  CARRIED_PRICE: "계산일의 가격 대신 허용 기간 안에 있는 이전 가격을 사용했습니다.",
  MISSING_FX: "환산에 필요한 환율이 없습니다. 해당 날짜의 통화쌍을 확인해 주세요.",
  STALE_FX: "최근 환율이 허용된 사용 기간을 넘었습니다. 환산 결과를 표시하지 않습니다.",
  CARRIED_FX: "계산일의 환율 대신 허용 기간 안에 있는 이전 참조 환율을 사용했습니다.",
  UNKNOWN_BENCHMARK: "등록되지 않은 벤치마크입니다. 설정에서 비교 종목을 확인해 주세요.",
  BENCHMARK_ZERO_PRICE: "벤치마크 시작 가격이 0이어서 비교 수익률을 계산할 수 없습니다.",
  BENCHMARK_FLOW_PRICE_MISSING: "입출금일의 벤치마크 가격이 없어 동일 현금흐름 비교를 계산할 수 없습니다.",
  BENCHMARK_NEGATIVE_CAPITAL: "가상 벤치마크 잔액보다 출금액이 큽니다. 임의 차입을 가정하지 않습니다.",
  CONFLICTING_MARKET_DATA: "같은 기준일에 서로 다른 관측치가 있습니다. 출처와 수집 이력을 확인하세요.",
  AMBIGUOUS_BENCHMARK_SPLIT: "벤치마크의 분할 기록이 일관되지 않아 기업행사 적용을 확인해야 합니다.",
  NEGATIVE_CASH: "계좌 현금이 부족합니다. 초기 입금과 거래 순서를 확인해 주세요.",
  OVERSELL: "보유 수량보다 매도 또는 이체 수량이 많습니다.",
  SPLIT_WITHOUT_HOLDING: "분할을 적용할 보유 수량이 없습니다.",
  INVALID_PERIOD: "조회 기간을 확인해 주세요.",
  INVALID_FILTER: "계좌와 표시 통화 필터를 확인해 주세요.",
  INVALID_COST_METHOD: "원가 계산 방식은 선입선출 또는 이동평균이어야 합니다.",
  INVALID_ASSET: "종목 정보가 올바르지 않거나 중복되어 있습니다.",
  INVALID_FX_RATE: "환율의 날짜, 통화쌍 또는 양수 값을 확인해 주세요.",
};

export function issueText(issue: DataIssue) {
  return issueLabels[issue.code] ?? (/[가-힣]/.test(issue.message) ? issue.message : "계산 조건을 확인해야 합니다. 데이터 출처와 거래 원장을 검토해 주세요.");
}
