import { describe, expect, it } from "vitest";
import { Prisma, type DividendEvent } from "@prisma/client";
import type { AssetInput, AnalysisFilters } from "@/lib/domain";
import type { TransactionDto } from "@/lib/contracts";
import { dividendInsights } from "@/lib/services/insights";

const asset: AssetInput = {
  id: "stock", symbol: "FIX", name: "Fixture", exchange: "NASDAQ",
  currency: "USD", assetClass: "STOCK", country: null, sector: null,
};
const filters: AnalysisFilters = {
  from: "2025-01-01", to: "2025-01-06", currency: "USD", accountIds: ["a"], costMethod: "FIFO",
};
const transaction = (id: string, date: string, sequence: number, values: Partial<TransactionDto>): TransactionDto => ({
  id, date, sequence, accountId: "a", kind: "DEPOSIT", currency: "USD",
  fee: "0", tax: "0", memo: "", tags: [], source: "MANUAL", revision: 1, dividendEventId: null,
  ...values,
});
const ledger = [
  transaction("deposit", "2025-01-01", 1, { amount: "1000" }),
  transaction("purchase", "2025-01-02", 2, { kind: "BUY", assetId: "stock", quantity: "10", price: "10" }),
  transaction("transfer", "2025-01-03", 3, { kind: "TRANSFER", assetId: "stock", quantity: "2", toAccountId: "b" }),
  transaction("split", "2025-01-04", 4, { kind: "SPLIT", assetId: "stock", ratio: "2" }),
  transaction("ex-day-buy", "2025-01-04", 5, { kind: "BUY", assetId: "stock", quantity: "4", price: "5" }),
];
const event: DividendEvent = {
  id: "event", userId: "user", assetId: "stock", status: "ESTIMATED", exDate: new Date("2025-01-04"),
  recordDate: null, payDate: new Date("2025-01-05"), asOf: new Date("2025-01-01"), createdAt: new Date("2025-01-01"),
  amountPerShare: new Prisma.Decimal("1"), currency: "USD", source: "MANUAL", basis: "Independent eligibility example",
};

describe("dividend eligibility and reconciliation", () => {
  it("uses pre-ex-date holdings, transferred lots, and effective splits, excluding ex-day purchases", () => {
    const result = dividendInsights([event], ledger, [asset], [], filters);
    // 10 shares - 2 transferred, then a 2:1 split = 16 entitled shares. The ex-day buy adds no eligibility.
    expect(result.upcoming[0].eligibleQuantity).toBe("16");
    expect(result.upcoming[0].expectedGross).toBe("16");
    expect(result.upcoming[0].missing.some((message) => message.includes("추정"))).toBe(true);
    expect(ledger[1].quantity).toBe("10");
  });

  it("prioritizes actual gross, withheld tax and net cash and removes the matched forecast", () => {
    const paid = [...ledger, transaction("receipt", "2025-01-05", 6, { kind: "DIVIDEND", assetId: "stock", amount: "16", tax: "2.4", dividendEventId: "event" })];
    const result = dividendInsights([event], paid, [asset], [], filters);
    expect(result.actual[0].net).toBe("13.6");
    expect(result.monthly[0]).toEqual({ key: "2025-01", gross: "16", tax: "2.4", net: "13.6" });
    expect(result.upcoming[0].expectedGross).toBe("0");
    expect(result.upcoming[0].receivedGross).toBe("16");
    expect(result.upcoming[0].reconciled).toBe(true);
  });

  it("keeps unknown dates and missing FX unknown instead of inventing dates or zero values", () => {
    const unknown = dividendInsights([{ ...event, exDate: null, payDate: null }], ledger, [asset], [], filters).upcoming[0];
    expect(unknown.payDate).toBeNull();
    expect(unknown.expectedGross).toBeNull();
    const paid = [...ledger, transaction("receipt", "2025-01-05", 6, { kind: "DIVIDEND", assetId: "stock", amount: "16", tax: "2.4" })];
    const foreign = dividendInsights([], paid, [asset], [], { ...filters, currency: "KRW" });
    expect(foreign.actual[0].netBase).toBeNull();
    expect(foreign.monthly[0].net).toBeNull();
  });

  it("reconciles only the receiving account, not every account in a combined portfolio", () => {
    const secondEvent = { ...event, exDate: new Date("2025-01-04"), amountPerShare: new Prisma.Decimal("1") };
    const paid = [...ledger, transaction("receipt", "2025-01-05", 6, { kind: "DIVIDEND", assetId: "stock", amount: "16", dividendEventId: "event" })];
    const result = dividendInsights([secondEvent], paid, [asset], [], { ...filters, accountIds: ["a", "b"] });
    expect(result.upcoming[0].expectedGross).toBe("2");
    expect(result.upcoming[0].reconciled).toBe(false);
  });
});
