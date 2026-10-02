import Decimal from "decimal.js";
import { z } from "zod";

const ExactDecimal = Decimal.clone({ precision: 80 });
export const currencySchema = z.enum(["KRW", "USD"]);
export const transactionKindSchema = z.enum([
  "BUY", "SELL", "DEPOSIT", "WITHDRAWAL", "DIVIDEND", "INTEREST",
  "FEE", "TAX", "FX", "TRANSFER", "SPLIT", "VALUATION",
]);
export const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/, "올바른 ID가 필요합니다.");
export const revisionSchema = z.number().int().min(1).max(2_147_483_646);
export const requestIdSchema = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$(?![\s\S])/, "요청 ID에는 공백을 사용할 수 없습니다.");

export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const dateSchema = z.string()
  .refine(isRealDate, "실제 존재하는 YYYY-MM-DD 날짜를 입력해 주세요.")
  .refine((value) => !isRealDate(value) || value <= new Date().toISOString().slice(0, 10), "미래 거래는 등록할 수 없습니다.");

// A spare integer digit leaves headroom for Decimal(30,12) cash calculations.
const decimalPattern = /^(?:0|[1-9]\d{0,16})(?:\.\d{1,12})?$(?![\s\S])/;
const isDecimal = (value: unknown): value is string => typeof value === "string" && decimalPattern.test(value);
export const decimalSchema = z.string().regex(
  decimalPattern,
  "숫자는 정수 17자리, 소수 12자리 이내의 음수가 아닌 문자열이어야 합니다.",
).transform((value) => new ExactDecimal(value).toFixed());
export const positiveDecimalSchema = decimalSchema.refine((value) => isDecimal(value) && new ExactDecimal(value).greaterThan(0), "0보다 커야 합니다.");
const optionalDecimal = decimalSchema.nullish().transform((value) => value ?? null);
const optionalId = idSchema.nullish().transform((value) => value ?? null);
const text = z.string().refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "제어 문자는 사용할 수 없습니다.");

const transactionFields = z.object({
  accountId: idSchema,
  date: dateSchema,
  kind: transactionKindSchema,
  currency: currencySchema,
  assetId: optionalId,
  quantity: optionalDecimal,
  price: optionalDecimal,
  amount: optionalDecimal,
  fee: decimalSchema.default("0"),
  tax: decimalSchema.default("0"),
  toAccountId: optionalId,
  toCurrency: currencySchema.nullish().transform((value) => value ?? null),
  toAmount: optionalDecimal,
  ratio: optionalDecimal,
  memo: text.max(1000).default(""),
  tags: z.array(text.trim().min(1).max(40)).max(20)
    .refine((tags) => new Set(tags).size === tags.length, "태그는 중복될 수 없습니다.").default([]),
  dividendEventId: optionalId,
}).strict();

type TransactionFields = z.output<typeof transactionFields>;
type DecimalField = "quantity" | "price" | "amount" | "fee" | "tax" | "toAmount" | "ratio";

function validateTransaction(value: TransactionFields, ctx: z.RefinementCtx): void {
  const error = (field: string, message: string) => ctx.addIssue({ code: "custom", path: [field], message });
  const number = (field: DecimalField) => isDecimal(value[field]) ? new ExactDecimal(value[field]!) : null;
  const positive = (field: DecimalField) => {
    if (!number(field)?.greaterThan(0)) error(field, "이 거래에는 0보다 큰 값이 필요합니다.");
  };
  const unused = (...fields: DecimalField[]) => {
    for (const field of fields) {
      const parsed = number(field);
      if (parsed && !parsed.isZero()) error(field, "이 거래 유형에서 사용하지 않는 값입니다.");
    }
  };
  const asset = () => { if (!value.assetId) error("assetId", "종목을 선택해 주세요."); };

  if (value.kind !== "DIVIDEND" && value.dividendEventId) error("dividendEventId", "배당 입금에만 배당 일정을 연결할 수 있습니다.");
  if (value.dividendEventId && !value.assetId) error("assetId", "배당 일정과 일치하는 종목이 필요합니다.");
  if (value.kind !== "TRANSFER" && value.toAccountId) error("toAccountId", "계좌 이체에만 받는 계좌를 지정할 수 있습니다.");
  if (value.kind !== "FX") {
    if (value.toCurrency) error("toCurrency", "환전에만 받는 통화를 지정할 수 있습니다.");
    unused("toAmount");
  }
  if (value.kind !== "SPLIT") unused("ratio");
  if (!["BUY", "SELL", "DIVIDEND", "TRANSFER", "SPLIT", "VALUATION"].includes(value.kind) && value.assetId) {
    error("assetId", "이 거래 유형에는 종목을 지정할 수 없습니다.");
  }

  switch (value.kind) {
    case "BUY":
    case "SELL": {
      asset();
      positive("quantity");
      positive("price");
      unused("amount");
      const quantity = number("quantity");
      const price = number("price");
      if (quantity && price) {
        const notional = quantity.times(price);
        if (notional.greaterThanOrEqualTo("100000000000000000") || notional.decimalPlaces() > 12) {
          error("price", "수량 × 가격의 결과가 금액의 정밀도 한도를 초과합니다.");
        }
      }
      break;
    }
    case "FX":
      positive("amount");
      positive("toAmount");
      unused("quantity", "price");
      if (!value.toCurrency || value.toCurrency === value.currency) error("toCurrency", "서로 다른 통화로 환전해야 합니다.");
      break;
    case "TRANSFER":
      if (!value.toAccountId || value.toAccountId === value.accountId) error("toAccountId", "서로 다른 두 계좌가 필요합니다.");
      unused("price");
      if (value.assetId) {
        positive("quantity");
        unused("amount");
      } else {
        positive("amount");
        unused("quantity");
      }
      break;
    case "SPLIT":
      asset();
      positive("ratio");
      unused("quantity", "price", "amount", "fee", "tax");
      break;
    case "VALUATION":
      asset();
      if (!number("price")) error("price", "사용자 정의 자산의 0 이상 단위 가격이 필요합니다.");
      unused("quantity", "amount", "fee", "tax");
      break;
    case "DIVIDEND":
      asset();
      positive("amount");
      unused("quantity", "price");
      break;
    default:
      positive("amount");
      unused("quantity", "price");
      if (value.kind === "FEE" || value.kind === "TAX") unused("fee", "tax");
  }
}

function normalizeUnused<T extends TransactionFields>(value: T): T {
  const normalized = { ...value };
  for (const field of ["quantity", "price", "amount", "toAmount", "ratio"] as const) {
    if (normalized[field] === "0" && !(field === "price" && normalized.kind === "VALUATION")) normalized[field] = null;
  }
  return normalized;
}

export const transactionSchema = transactionFields.superRefine(validateTransaction).transform(normalizeUnused);
export const transactionUpdateSchema = transactionFields.extend({ revision: revisionSchema }).superRefine(validateTransaction).transform(normalizeUnused);
export type TransactionInput = z.output<typeof transactionSchema>;
export type TransactionUpdateInput = z.output<typeof transactionUpdateSchema>;
export type TransactionPayload = z.input<typeof transactionSchema>;
