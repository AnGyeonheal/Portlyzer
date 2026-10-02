import type {
  AssetInput, CostMethod, Currency, DataIssue, LedgerTransaction, TransactionKind,
} from "../domain";
import { Issues, ZERO, decimal, validDate, type D } from "./decimal";

export interface ParsedTransaction {
  raw: LedgerTransaction;
  fee: D;
  tax: D;
  quantity: D | null;
  price: D | null;
  amount: D | null;
  toAmount: D | null;
  ratio: D | null;
}

const KINDS = new Set<TransactionKind>([
  "BUY", "SELL", "DEPOSIT", "WITHDRAWAL", "DIVIDEND", "INTEREST", "FEE",
  "TAX", "FX", "TRANSFER", "SPLIT", "VALUATION",
]);

export function isCurrency(value: unknown): value is Currency {
  return value === "KRW" || value === "USD";
}

export function transactionOrder(a: LedgerTransaction, b: LedgerTransaction): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 :
    a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function prepareLedger(
  transactions: LedgerTransaction[],
  assets: AssetInput[],
  costMethod: CostMethod,
  issues: Issues,
): ParsedTransaction[] {
  if (costMethod !== "FIFO" && costMethod !== "AVERAGE") {
    issues.add({ code: "INVALID_COST_METHOD", message: "Cost method must be FIFO or AVERAGE.", severity: "error" });
  }
  const assetMap = new Map<string, AssetInput>();
  for (const asset of assets) {
    if (!asset.id || assetMap.has(asset.id) || !isCurrency(asset.currency) ||
      !["STOCK", "ETF", "CRYPTO", "CUSTOM"].includes(asset.assetClass)) {
      issues.add({ code: "INVALID_ASSET", message: `Invalid or duplicate asset: ${asset.id}.`, assetId: asset.id, severity: "error" });
    } else {
      assetMap.set(asset.id, asset);
    }
  }
  const ids = new Set<string>();
  const parsed: ParsedTransaction[] = [];
  for (const raw of [...transactions].sort(transactionOrder)) {
    let invalid = false;
    const fail = (code: string, message: string) => {
      invalid = true;
      issues.add({ code, message, transactionId: raw.id, date: raw.date, assetId: raw.assetId ?? undefined, severity: "error" });
    };
    if (!raw.id || ids.has(raw.id)) fail("DUPLICATE_TRANSACTION", "Transaction IDs must be present and unique.");
    ids.add(raw.id);
    if (!validDate(raw.date)) fail("INVALID_DATE", "Transaction date must be an actual YYYY-MM-DD calendar date.");
    if (!Number.isSafeInteger(raw.sequence) || raw.sequence < 0) fail("INVALID_SEQUENCE", "Sequence must be a nonnegative safe integer.");
    if (typeof raw.accountId !== "string" || !raw.accountId.trim()) fail("INVALID_ACCOUNT", "A source account is required.");
    if (typeof raw.memo !== "string" || !Array.isArray(raw.tags) || raw.tags.some(tag => typeof tag !== "string")) {
      fail("INVALID_METADATA", "Memo must be a string and tags must be an array of strings.");
    }
    if (!isCurrency(raw.currency)) fail("INVALID_CURRENCY", "Unsupported transaction currency.");
    if (!KINDS.has(raw.kind)) fail("INVALID_KIND", "Unknown transaction kind.");
    const numbers: Record<string, D | null> = {};
    for (const field of ["fee", "tax", "quantity", "price", "amount", "toAmount", "ratio"] as const) {
      const value = raw[field];
      numbers[field] = value == null ? null : decimal(value);
      if ((value != null || field === "fee" || field === "tax") && numbers[field] === null) {
        fail("INVALID_NUMBER", `${field} must be a finite decimal string (maximum 128 characters, exponent ±100).`);
      }
      if (numbers[field]?.isNegative()) fail("NEGATIVE_AMOUNT", `${field} cannot be negative.`);
    }
    const { quantity, price, amount, toAmount, ratio } = numbers;
    const fee = numbers.fee ?? ZERO;
    const tax = numbers.tax ?? ZERO;
    const positive = (field: string, value: D | null) => {
      if (value === null || !value.gt(0)) fail("MISSING_OR_ZERO_AMOUNT", `${field} must be greater than zero for ${raw.kind}.`);
    };
    const disallow = (...fields: (keyof LedgerTransaction)[]) => {
      for (const field of fields) {
        if (raw[field] != null && raw[field] !== "") fail("UNEXPECTED_FIELD", `${field} is not applicable to ${raw.kind}.`);
      }
    };
    const requireAsset = () => {
      if (!raw.assetId) fail("MISSING_ASSET", `${raw.kind} requires an asset.`);
    };
    const asset = raw.assetId ? assetMap.get(raw.assetId) : undefined;
    if (raw.assetId && !asset) fail("UNKNOWN_ASSET", `Unknown asset: ${raw.assetId}.`);
    if (asset && asset.currency !== raw.currency) fail("ASSET_CURRENCY_MISMATCH", "Transaction currency must match the asset's native currency.");
    if (raw.toCurrency != null && !isCurrency(raw.toCurrency)) fail("INVALID_CURRENCY", "Unsupported destination currency.");

    switch (raw.kind) {
      case "BUY":
      case "SELL":
        requireAsset();
        positive("quantity", quantity);
        positive("price", price);
        disallow("toAccountId", "toCurrency", "toAmount", "ratio");
        if (amount !== null && quantity !== null && price !== null && !amount.eq(quantity.times(price))) {
          fail("TRADE_AMOUNT_MISMATCH", "Optional trade amount must equal quantity × price before fees and taxes.");
        }
        if (raw.kind === "SELL" && quantity && price && fee.plus(tax).gt(quantity.times(price))) {
          fail("COSTS_EXCEED_PROCEEDS", "Sale fees and taxes cannot exceed gross sale proceeds.");
        }
        break;
      case "DIVIDEND":
        requireAsset();
        positive("amount", amount);
        disallow("quantity", "price", "toAccountId", "toCurrency", "toAmount", "ratio");
        if (amount && fee.plus(tax).gt(amount)) fail("COSTS_EXCEED_PROCEEDS", "Withholding and fees cannot exceed the gross dividend.");
        break;
      case "INTEREST":
      case "DEPOSIT":
        positive("amount", amount);
        disallow("assetId", "quantity", "price", "toAccountId", "toCurrency", "toAmount", "ratio");
        if (amount && fee.plus(tax).gt(amount)) fail("COSTS_EXCEED_PROCEEDS", "Fees and taxes cannot exceed the incoming amount.");
        break;
      case "WITHDRAWAL":
      case "FEE":
      case "TAX":
        positive("amount", amount);
        disallow("assetId", "quantity", "price", "toAccountId", "toCurrency", "toAmount", "ratio");
        break;
      case "FX":
        positive("amount", amount);
        positive("toAmount", toAmount);
        disallow("assetId", "quantity", "price", "toAccountId", "ratio");
        if (!raw.toCurrency || raw.toCurrency === raw.currency) {
          fail("INVALID_FX", "FX requires a different, supported destination currency and its actual received amount.");
        }
        break;
      case "TRANSFER":
        if (!raw.toAccountId || !raw.toAccountId.trim() || raw.toAccountId === raw.accountId) {
          fail("INVALID_TRANSFER", "A transfer requires a distinct destination account.");
        }
        if (raw.toCurrency && raw.toCurrency !== raw.currency) {
          fail("INVALID_TRANSFER", "Transfers do not convert currencies; record currency conversion as FX.");
        }
        disallow("price", "ratio");
        if (raw.assetId) {
          positive("quantity", quantity);
          disallow("amount", "toAmount");
        } else {
          positive("amount", amount);
          disallow("quantity");
          if (toAmount !== null && amount !== null && !toAmount.eq(amount)) {
            fail("TRANSFER_AMOUNT_MISMATCH", "A cash transfer must credit exactly the amount sent; charges are paid separately.");
          }
        }
        break;
      case "SPLIT":
        requireAsset();
        positive("ratio", ratio);
        disallow("price", "amount", "toAccountId", "toCurrency", "toAmount");
        if (quantity !== null && !quantity.isZero()) {
          fail("INVALID_CORPORATE_ACTION", "A split uses its ratio, not an explicit nonzero quantity.");
        }
        if (!fee.isZero() || !tax.isZero()) fail("INVALID_CORPORATE_ACTION", "A split changes quantity only and cannot have fees or taxes.");
        break;
      case "VALUATION":
        requireAsset();
        if (price === null) fail("MISSING_VALUATION", "A custom valuation requires a nonnegative per-unit price.");
        if (asset && asset.assetClass !== "CUSTOM") fail("INVALID_VALUATION", "Only CUSTOM assets support valuation overrides.");
        disallow("quantity", "amount", "toAccountId", "toCurrency", "toAmount", "ratio");
        if (!fee.isZero() || !tax.isZero()) fail("INVALID_CORPORATE_ACTION", "Valuation overrides cannot have fees or taxes.");
        break;
    }
    if (!invalid) parsed.push({ raw, fee, tax, quantity, price, amount, toAmount, ratio });
  }
  return parsed;
}

export function checkBalances(parsed: ParsedTransaction[], issues: Issues): Map<string, D> {
  const cash = new Map<string, D>();
  const quantities = new Map<string, D>();
  const key = (account: string, item: string) => JSON.stringify([account, item]);
  for (const tx of parsed) {
    const { raw, fee, tax, amount, quantity, price, toAmount, ratio } = tx;
    const cashChanges = new Map<string, D>();
    const quantityChanges = new Map<string, D>();
    const quantityOverrides = new Map<string, D>();
    const delta = (changes: Map<string, D>, k: string, value: D) =>
      changes.set(k, (changes.get(k) ?? ZERO).plus(value));
    const money = (value: D, account = raw.accountId, currency = raw.currency) =>
      delta(cashChanges, key(account, currency), value);
    const units = (value: D, account = raw.accountId) =>
      delta(quantityChanges, key(account, raw.assetId!), value);
    let invalid = false;
    switch (raw.kind) {
      case "BUY":
        money(quantity!.times(price!).plus(fee).plus(tax).negated());
        units(quantity!);
        break;
      case "SELL":
        money(quantity!.times(price!).minus(fee).minus(tax));
        units(quantity!.negated());
        break;
      case "DEPOSIT":
      case "DIVIDEND":
      case "INTEREST":
        money(amount!.minus(fee).minus(tax));
        break;
      case "WITHDRAWAL":
      case "FEE":
      case "TAX":
        money(amount!.plus(fee).plus(tax).negated());
        break;
      case "FX":
        money(amount!.plus(fee).plus(tax).negated());
        money(toAmount!, raw.accountId, raw.toCurrency!);
        break;
      case "TRANSFER":
        money(fee.plus(tax).negated());
        if (raw.assetId) {
          units(quantity!.negated());
          units(quantity!, raw.toAccountId!);
        } else {
          money(amount!.negated());
          money(amount!, raw.toAccountId!);
        }
        break;
      case "SPLIT": {
        const balance = quantities.get(key(raw.accountId, raw.assetId!)) ?? ZERO;
        if (!balance.gt(0)) {
          invalid = true;
          issues.add({ code: "SPLIT_WITHOUT_HOLDING", message: "A split requires a positive holding in the source account.", date: raw.date, transactionId: raw.id, assetId: raw.assetId!, severity: "error" });
        }
        quantityOverrides.set(key(raw.accountId, raw.assetId!), balance.times(ratio!));
        break;
      }
      case "VALUATION":
        break;
    }
    for (const [k, change] of cashChanges) {
      if ((cash.get(k) ?? ZERO).plus(change).lt(0)) {
        invalid = true;
        const [account, currency] = JSON.parse(k) as [string, Currency];
        issues.add({ code: "NEGATIVE_CASH", message: `Insufficient ${currency} cash in account ${account}; opening balances must be explicit deposits.`, date: raw.date, transactionId: raw.id, severity: "error" });
      }
    }
    for (const [k, change] of quantityChanges) {
      if ((quantities.get(k) ?? ZERO).plus(change).lt(0)) {
        invalid = true;
        issues.add({ code: "OVERSELL", message: `Insufficient asset quantity in account ${raw.accountId}.`, date: raw.date, transactionId: raw.id, assetId: raw.assetId!, severity: "error" });
      }
    }
    // Invalid records are atomic: never credit a destination or spend other cash.
    if (!invalid) {
      for (const [k, change] of cashChanges) cash.set(k, (cash.get(k) ?? ZERO).plus(change));
      for (const [k, change] of quantityChanges) quantities.set(k, (quantities.get(k) ?? ZERO).plus(change));
      for (const [k, value] of quantityOverrides) quantities.set(k, value);
    }
  }
  return quantities;
}

export function validateLedger(
  transactions: LedgerTransaction[],
  assets: AssetInput[],
  costMethod: CostMethod,
): DataIssue[] {
  const issues = new Issues();
  const parsed = prepareLedger(transactions, assets, costMethod, issues);
  checkBalances(parsed, issues);
  return issues.values;
}
