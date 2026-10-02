import { afterEach, describe, expect, it, vi } from "vitest";
import { transactionSchema, transactionUpdateSchema } from "../../src/lib/validation";
import { normalizeImportDate, normalizeImportDecimal, normalizeImportKind } from "../../src/lib/services/imports";

const base = { accountId: "account-1", date: "2024-02-29", currency: "USD" };
const buy = { ...base, kind: "BUY", assetId: "asset-1", quantity: "2", price: "10.125" };

afterEach(() => vi.useRealTimers());

describe("strict transaction input", () => {
  it("defaults charges without converting decimal strings to binary numbers", () => {
    const result = transactionSchema.parse({ ...base, kind: "DEPOSIT", amount: "99999999999999999.123456789012" });
    expect(result.amount).toBe("99999999999999999.123456789012");
    expect(result.fee).toBe("0");
    expect(result.tax).toBe("0");
    expect(result.memo).toBe("");
    expect(result.tags).toEqual([]);
    expect(result.dividendEventId).toBeNull();
  });

  it.each([
    { kind: "BUY", assetId: "asset-1", quantity: "2", price: "10" },
    { kind: "SELL", assetId: "asset-1", quantity: "2", price: "10" },
    { kind: "DEPOSIT", amount: "10" },
    { kind: "WITHDRAWAL", amount: "10" },
    { kind: "DIVIDEND", assetId: "asset-1", amount: "10", tax: "1.5", dividendEventId: "event-1" },
    { kind: "INTEREST", amount: "10" },
    { kind: "FEE", amount: "10" },
    { kind: "TAX", amount: "10" },
    { kind: "FX", amount: "10", toCurrency: "KRW", toAmount: "13500" },
    { kind: "TRANSFER", amount: "10", toAccountId: "account-2" },
    { kind: "TRANSFER", assetId: "asset-1", quantity: "2", toAccountId: "account-2" },
    { kind: "SPLIT", assetId: "asset-1", ratio: "2", quantity: "0" },
    { kind: "VALUATION", assetId: "custom-1", price: "10" },
    { kind: "VALUATION", assetId: "custom-1", price: "0" },
  ])("accepts supported $kind inputs", (fields) => {
    expect(transactionSchema.safeParse({ ...base, ...fields }).success).toBe(true);
  });

  it.each([
    "", "-1", "+1", ".5", "1.", "01", "1,000", "1e3", "NaN", "Infinity", "=1+1",
    "100000000000000000", "0.1234567890123", "1.0000000000000", " 1 ", "1\n",
  ])("rejects noncanonical or out-of-range decimal %j without throwing", (amount) => {
    expect(transactionSchema.safeParse({ ...base, kind: "DEPOSIT", amount }).success).toBe(false);
  });

  it("rejects JS numbers, unknown fields, and missing/zero required values", () => {
    for (const value of [
      { ...buy, quantity: 2 }, { ...buy, quantity: "0" }, { ...buy, price: undefined },
      { ...buy, id: "injected" }, { ...buy, userId: "other" }, { ...buy, sequence: 1 },
      { ...base, kind: "UNKNOWN", amount: "2" }, { ...base, kind: "DEPOSIT", currency: "EUR", amount: "2" },
    ]) expect(transactionSchema.safeParse(value).success).toBe(false);
  });

  it("rejects nonzero fields irrelevant to the selected kind", () => {
    for (const value of [
      { ...buy, amount: "20.25" }, { ...buy, ratio: "2" }, { ...buy, toAmount: "1" },
      { ...base, kind: "DEPOSIT", amount: "1", quantity: "1" },
      { ...base, kind: "FEE", amount: "1", fee: "1" },
      { ...base, kind: "TAX", amount: "1", tax: "1" },
      { ...base, kind: "SPLIT", assetId: "asset-1", ratio: "2", quantity: "1" },
      { ...base, kind: "SPLIT", assetId: "asset-1", ratio: "2", fee: "1" },
      { ...base, kind: "VALUATION", assetId: "asset-1", price: "10", amount: "10" },
      { ...base, kind: "VALUATION", assetId: "asset-1", price: "10", tax: "1" },
    ]) expect(transactionSchema.safeParse(value).success).toBe(false);
  });

  it("normalizes unused zero decimals to null for the calculation engine", () => {
    const result = transactionSchema.parse({ ...base, kind: "SPLIT", assetId: "asset-1", ratio: "2.0", quantity: "0.00", amount: "0", price: "0", toAmount: "0" });
    expect(result).toMatchObject({ ratio: "2", quantity: null, amount: null, price: null, toAmount: null });
  });

  it("preserves a worthless custom asset's zero valuation without allowing free purchases", () => {
    const value = transactionSchema.parse({ ...base, kind: "VALUATION", assetId: "custom-1", price: "0.000", quantity: "0" });
    expect(value).toMatchObject({ price: "0", quantity: null, amount: null });
    expect(transactionSchema.safeParse({ ...base, kind: "VALUATION", assetId: "custom-1" }).success).toBe(false);
    expect(transactionSchema.safeParse({ ...buy, price: "0" }).success).toBe(false);
  });

  it("requires balanced distinct-account transfers and explicit FX legs", () => {
    const transfer = { ...base, kind: "TRANSFER", amount: "10", toAccountId: "account-2" };
    for (const value of [
      { ...transfer, toAccountId: "account-1" }, { ...transfer, toCurrency: "KRW" },
      { ...transfer, toAmount: "9" }, { ...transfer, assetId: "asset-1", quantity: "1" },
      { ...base, kind: "FX", amount: "10", toCurrency: "USD", toAmount: "10" },
      { ...base, kind: "FX", amount: "10", toCurrency: "KRW" },
      { ...base, kind: "FX", amount: "10", toCurrency: "KRW", toAmount: "1", toAccountId: "account-2" },
    ]) expect(transactionSchema.safeParse(value).success).toBe(false);
  });

  it("requires a dividend asset and restricts event links to dividends", () => {
    expect(transactionSchema.safeParse({ ...base, kind: "DIVIDEND", amount: "10" }).success).toBe(false);
    expect(transactionSchema.safeParse({ ...buy, dividendEventId: "event-1" }).success).toBe(false);
  });

  it("bounds metadata, IDs and optimistic revisions", () => {
    for (const value of [
      { ...buy, accountId: "../other" }, { ...buy, assetId: "x".repeat(129) },
      { ...buy, memo: "x".repeat(1001) }, { ...buy, memo: "\u0000" },
      { ...buy, tags: ["same", "same"] }, { ...buy, tags: ["x".repeat(41)] },
      { ...buy, tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`) },
    ]) expect(transactionSchema.safeParse(value).success).toBe(false);
    expect(transactionUpdateSchema.safeParse(buy).success).toBe(false);
    expect(transactionUpdateSchema.safeParse({ ...buy, revision: 0 }).success).toBe(false);
    expect(transactionUpdateSchema.parse({ ...buy, revision: 2 }).revision).toBe(2);
  });

  it("rejects calculated notional precision loss and overflow", () => {
    expect(transactionSchema.safeParse({ ...buy, quantity: "0.000000000001", price: "0.1" }).success).toBe(false);
    expect(transactionSchema.safeParse({ ...buy, quantity: "99999999999999999", price: "2" }).success).toBe(false);
  });

  it("accepts only real nonfuture ISO dates for manual transactions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T05:00:00.000Z"));
    for (const date of ["2023-02-29", "2024-04-31", "0000-01-01", "2026-10-03", "2024/02/29", "02/29/2024", "2024-2-29"]) {
      expect(transactionSchema.safeParse({ ...buy, date }).success).toBe(false);
    }
    expect(transactionSchema.safeParse({ ...buy, date: "2026-10-02" }).success).toBe(true);
  });
});

describe("generic import normalization", () => {
  it.each(["2024-02-29", "2024/02/29", "2024.02.29", "20240229"])("normalizes explicit year-first date %s", (value) => {
    expect(normalizeImportDate(value)).toBe("2024-02-29");
  });
  it.each(["01/02/2024", "02/01/2024", "2024/2/01", "20240230", "2023.02.29", "2024/02.29", "2024-02-29T00:00:00Z"])("rejects ambiguous or invalid date %s", (value) => {
    expect(() => normalizeImportDate(value)).toThrow();
  });
  it.each([
    ["1,234.5000", "1234.5"], ["12,345,678", "12345678"], ["000012.340", "12.34"],
    [" 0.000000000001 ", "0.000000000001"], ["99999999999999999.123456789012", "99999999999999999.123456789012"],
  ])("normalizes unambiguous decimal %s", (input, output) => {
    expect(normalizeImportDecimal(input)).toBe(output);
  });
  it.each(["1,23", "1.234,56", "0,123", "12,34,567", "1 234", "-1", "+1", "1e2", "NaN", "=1+1", "1.0000000000000"])("rejects ambiguous or expression decimal %s", (value) => {
    expect(() => normalizeImportDecimal(value)).toThrow();
  });
  it.each([
    ["매수", "BUY"], ["매도", "SELL"], ["배당금", "DIVIDEND"], ["환전", "FX"],
    ["이체", "TRANSFER"], ["액면분할", "SPLIT"], ["병합", "SPLIT"], ["평가", "VALUATION"], [" tax ", "TAX"],
  ])("maps generic action label %s", (input, output) => {
    expect(normalizeImportKind(input)).toBe(output);
  });
  it("does not infer unknown broker action descriptions", () => {
    expect(() => normalizeImportKind("해외증권정산입금(매도?)")).toThrow();
  });
});
