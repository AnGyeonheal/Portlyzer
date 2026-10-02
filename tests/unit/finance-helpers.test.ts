import { describe, expect, it } from "vitest";
import {
  convertCurrency, historicalQuantities, FinanceValidationError,
  type AssetInput, type CostMethod, type FxInput, type LedgerTransaction,
} from "../../src/lib/finance";

const stock: AssetInput = {
  id: "stock", symbol: "STK", name: "Stock", exchange: "TEST", currency: "USD",
  assetClass: "STOCK", country: null, sector: null,
};
const tx = (id: string, date: string, kind: LedgerTransaction["kind"], fields: Partial<LedgerTransaction> = {}): LedgerTransaction => ({
  id, date, kind, accountId: "A", currency: "USD", sequence: 0, fee: "0", tax: "0", memo: "", tags: [], ...fields,
});
const fx = (date: string, rate: string): FxInput => ({
  date, base: "USD", quote: "KRW", rate, source: "fixture", fetchedAt: `${date}T18:00:00Z`,
});

describe("shared FX conversion helper", () => {
  it("applies the same reporting direction and exact Decimal arithmetic", () => {
    expect(convertCurrency("0.1", "USD", "KRW", "2025-01-01", [fx("2025-01-01", "1400")])).toBe("140");
    expect(convertCurrency("-2.5", "USD", "KRW", "2025-01-01", [fx("2025-01-01", "1400")])).toBe("-3500");
    expect(convertCurrency("14000", "KRW", "USD", "2025-01-01", [fx("2025-01-01", "1400")])).toBe("10");
  });

  it("never uses future FX and expires observations after seven calendar days", () => {
    const observations = [fx("2025-01-01", "1000"), fx("2025-01-10", "2000")];
    expect(convertCurrency("2", "USD", "KRW", "2024-12-31", observations)).toBeNull();
    expect(convertCurrency("2", "USD", "KRW", "2025-01-08", observations)).toBe("2000");
    expect(convertCurrency("2", "USD", "KRW", "2025-01-09", observations)).toBeNull();
    expect(convertCurrency("2", "USD", "KRW", "2025-01-10", observations)).toBe("4000");
  });

  it("supports inverse-only observations", () => {
    expect(convertCurrency("3", "USD", "KRW", "2025-01-01", [
      { ...fx("2025-01-01", "0.0005"), base: "KRW", quote: "USD" },
    ])).toBe("6000");
  });

  it("requires no quote for identity conversion or a genuine zero balance", () => {
    expect(convertCurrency("123.4567890123456789", "USD", "USD", "2025-01-01", [])).toBe("123.4567890123456789");
    expect(convertCurrency("0", "USD", "KRW", "2025-01-01", [])).toBe("0");
    expect(convertCurrency("1", "USD", "KRW", "2025-01-01", [])).toBeNull();
  });

  it("rejects invalid numbers and dates rather than making up a zero conversion", () => {
    expect(convertCurrency("NaN", "USD", "USD", "2025-01-01", [])).toBeNull();
    expect(convertCurrency("1", "USD", "USD", "2025-02-30", [])).toBeNull();
  });
});

describe("shared price-independent end-of-day holdings replay", () => {
  const transactions = [
    tx("d", "2025-01-01", "DEPOSIT", { amount: "100" }),
    tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "10", price: "10" }),
    tx("split", "2025-01-02", "SPLIT", { assetId: "stock", ratio: "2" }),
    tx("move", "2025-01-02", "TRANSFER", { sequence: 1, assetId: "stock", quantity: "6", toAccountId: "B" }),
    tx("s", "2025-01-03", "SELL", { accountId: "B", assetId: "stock", quantity: "2", price: "5" }),
  ];

  it.each(["FIFO", "AVERAGE"] as CostMethod[])("replays split, transfer and disposal quantities under %s without any price series", costMethod => {
    expect(historicalQuantities([...transactions].reverse(), [stock], "2025-01-02", costMethod)).toEqual([
      { accountId: "A", assetId: "stock", quantity: "14" },
      { accountId: "B", assetId: "stock", quantity: "6" },
    ]);
    expect(historicalQuantities(transactions, [stock], "2025-01-03", costMethod)).toEqual([
      { accountId: "A", assetId: "stock", quantity: "14" },
      { accountId: "B", assetId: "stock", quantity: "4" },
    ]);
  });

  it("returns the previous day's holding without automatically applying ex-date transactions", () => {
    expect(historicalQuantities(transactions, [stock], "2025-01-01")).toEqual([
      { accountId: "A", assetId: "stock", quantity: "10" },
    ]);
    expect(historicalQuantities(transactions, [stock], "2024-12-31")).toEqual([]);
  });

  it("replays actual FX cash legs and foreign acquisitions without requiring market FX observations", () => {
    expect(historicalQuantities([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "1" }),
      tx("fx", "2025-01-01", "FX", { sequence: 1, amount: "1", toCurrency: "KRW", toAmount: "1400" }),
      tx("b", "2025-01-01", "BUY", { sequence: 2, currency: "KRW", assetId: "stock", quantity: "2", price: "700" }),
    ], [{ ...stock, currency: "KRW" }], "2025-01-01")).toEqual([
      { accountId: "A", assetId: "stock", quantity: "2" },
    ]);
  });

  it("removes fully liquidated holdings rather than reporting invented residual units", () => {
    expect(historicalQuantities([
      transactions[0], transactions[1],
      tx("sold", "2025-01-02", "SELL", { assetId: "stock", quantity: "10", price: "10" }),
    ], [stock], "2025-01-02")).toEqual([]);
  });

  it("applies reverse-split targets directly, avoiding cancellation of very small valid quantities", () => {
    const rows = [
      tx("d", "2025-01-01", "DEPOSIT", { amount: "1" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "1" }),
      tx("split", "2025-01-02", "SPLIT", { assetId: "stock", ratio: "1e-60" }),
    ];
    expect(historicalQuantities(rows, [stock], "2025-01-02")[0].quantity).toBe(`0.${"0".repeat(59)}1`);
  });

  it("throws an inspectable validation error for invalid history instead of returning an empty portfolio", () => {
    expect(() => historicalQuantities([transactions[1]], [stock], "2025-01-01")).toThrow(FinanceValidationError);
    try {
      historicalQuantities([transactions[1]], [stock], "2025-01-01");
    } catch (error) {
      expect(error).toBeInstanceOf(FinanceValidationError);
      expect((error as FinanceValidationError).issues.some(issue => issue.code === "NEGATIVE_CASH")).toBe(true);
    }
    expect(() => historicalQuantities(transactions, [stock], "2025-02-30")).toThrow(FinanceValidationError);
  });

  it("does not let future-invalid history invalidate an earlier quantity snapshot", () => {
    expect(historicalQuantities([
      ...transactions,
      tx("future", "2026-01-01", "SELL", { assetId: "stock", quantity: "100", price: "10" }),
    ], [stock], "2025-01-01")).toEqual([
      { accountId: "A", assetId: "stock", quantity: "10" },
    ]);
  });
});
