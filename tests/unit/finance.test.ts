import { describe, expect, it } from "vitest";
import {
  analyzePortfolio, validateLedger,
  type AnalysisInput, type AssetInput, type CostMethod, type FxInput,
  type LedgerTransaction, type PriceInput,
} from "../../src/lib/finance";

const stock: AssetInput = {
  id: "stock", symbol: "TEST", name: "Test security", exchange: "TEST",
  currency: "USD", assetClass: "STOCK", country: null, sector: null,
};

function tx(
  id: string, date: string, kind: LedgerTransaction["kind"],
  fields: Partial<LedgerTransaction> = {},
): LedgerTransaction {
  return { id, date, kind, sequence: 0, accountId: "A", currency: "USD", fee: "0", tax: "0", memo: "", tags: [], ...fields };
}

function price(date: string, close: string, assetId = "stock"): PriceInput {
  return { assetId, date, close, currency: "USD", adjustment: "RAW", source: "fixture", fetchedAt: `${date}T18:00:00Z` };
}

function fx(date: string, rate: string): FxInput {
  return { date, base: "USD", quote: "KRW", rate, source: "fixture", fetchedAt: `${date}T18:00:00Z` };
}

function analyze(transactions: LedgerTransaction[], prices: PriceInput[], overrides: Partial<AnalysisInput> = {}) {
  return analyzePortfolio({
    transactions, assets: [stock], prices, fx: [],
    filters: { from: "2025-01-01", to: "2025-01-04", currency: "USD", accountIds: [], costMethod: "FIFO" },
    ...overrides,
  });
}

function near(actual: string | null, expected: number, digits = 10) {
  expect(actual).not.toBeNull();
  expect(Number(actual)).toBeCloseTo(expected, digits);
}

describe("native acquisition costs, expenses and trade lifecycles", () => {
  const transactions = [
    tx("deposit", "2025-01-01", "DEPOSIT", { amount: "1000" }),
    tx("buy-one", "2025-01-02", "BUY", { assetId: "stock", quantity: "10", price: "10", fee: "2", tax: "1", memo: "first lot", tags: ["long-term"] }),
    tx("buy-two", "2025-01-03", "BUY", { assetId: "stock", quantity: "10", price: "20", fee: "4", tax: "2" }),
    tx("dividend", "2025-01-03", "DIVIDEND", { sequence: 1, assetId: "stock", amount: "20", tax: "3", fee: "1" }),
    tx("sell", "2025-01-04", "SELL", { assetId: "stock", quantity: "12", price: "30", fee: "6", tax: "3" }),
  ];
  const prices = [price("2025-01-02", "10"), price("2025-01-03", "20"), price("2025-01-04", "30")];

  it.each([
    ["FIFO", "164.8", "206.8", "75.2", "20.6"],
    ["AVERAGE", "123.6", "165.6", "116.4", "15.45"],
  ] as const)("accounts independently for partial sales with %s", (costMethod, cost, realized, unrealized, average) => {
    const result = analyze(transactions, prices, {
      filters: { from: "2025-01-01", to: "2025-01-04", currency: "USD", accountIds: [], costMethod },
    });
    // Cash: 1000 - 103 - 206 + (20 - 3 - 1) + (360 - 6 - 3) = 1058.
    // FIFO sold cost 103 + 2/10*206 = 144.2; average sold cost 12/20*309 = 185.4.
    expect(result.cash[0].balance).toBe("1058");
    expect(result.summary.totalValue).toBe("1298");
    expect(result.summary.totalPnl).toBe("298");
    expect(result.summary.netContributions).toBe("1000");
    expect(result.summary.costBasis).toBe(cost);
    expect(result.summary.realizedPnl).toBe(realized);
    expect(result.summary.unrealizedPnl).toBe(unrealized);
    expect(result.summary.dividends).toBe("16");
    expect(result.summary.grossDividends).toBe("20");
    expect(result.summary.fees).toBe("13");
    expect(result.summary.taxes).toBe("9");
    expect(result.positions[0]).toMatchObject({
      quantity: "8", averageCost: average, costBasis: cost, value: "240",
      unrealizedPnl: unrealized, realizedPnlBase: realized, dividendsBase: "16",
    });
    near(result.summary.simpleReturn, 0.298);
    near(result.summary.twr, 0.298);
    near(result.summary.mdd, -0.003);
    expect(result.issues.filter(issue => issue.severity === "error")).toEqual([]);
  });

  it("exposes genuine FIFO lot closure, partial status, fees and holding dates", () => {
    const result = analyze(transactions, prices);
    expect(result.trades[0]).toMatchObject({
      id: "buy-one", status: "CLOSED", closedReason: "SOLD", closedOn: "2025-01-04",
      quantity: "10", remainingQuantity: "0", soldQuantity: "10", holdingDays: 2,
      realizedPnlBase: "189.5", unrealizedPnlBase: "0", dividendsBase: "8",
      memo: "first lot", tags: ["long-term"],
    });
    expect(result.trades[1]).toMatchObject({
      status: "PARTIAL", remainingQuantity: "8", realizedPnlBase: "17.3",
      unrealizedPnlBase: "75.2", dividendsBase: "8", holdingDays: 1,
    });
    near(result.trades[0].returnRate, 197.5 / 103);
  });

  it("depletes average-cost acquisition cohorts proportionally", () => {
    const result = analyze(transactions, prices, {
      filters: { from: "2025-01-01", to: "2025-01-04", currency: "USD", accountIds: [], costMethod: "AVERAGE" },
    });
    expect(result.trades.map(lot => [lot.remainingQuantity, lot.realizedPnlBase, lot.status]))
      .toEqual([["4", "113.7", "PARTIAL"], ["4", "51.9", "PARTIAL"]]);
  });

  it("closes recurring-decimal average allocations completely and conserves total acquisition cost", () => {
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "6" }),
      tx("b1", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "1" }),
      tx("b2", "2025-01-01", "BUY", { sequence: 2, assetId: "stock", quantity: "1", price: "2" }),
      tx("b3", "2025-01-01", "BUY", { sequence: 3, assetId: "stock", quantity: "1", price: "3" }),
      tx("s1", "2025-01-02", "SELL", { assetId: "stock", quantity: "1", price: "4" }),
      tx("s2", "2025-01-03", "SELL", { assetId: "stock", quantity: "2", price: "4" }),
    ], [price("2025-01-01", "2"), price("2025-01-02", "4")], {
      filters: { from: "2025-01-01", to: "2025-01-03", currency: "USD", accountIds: [], costMethod: "AVERAGE" },
    });
    expect(result.summary.totalValue).toBe("12");
    expect(result.summary.costBasis).toBe("0");
    near(result.summary.realizedPnl, 6);
    expect(result.trades.every(lot => lot.remainingQuantity === "0" && lot.status === "CLOSED")).toBe(true);
  });

  it("fully moves and closes average cohorts after fractional splits without residual cost dust", () => {
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "6" }),
      tx("b1", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "1" }),
      tx("b2", "2025-01-01", "BUY", { sequence: 2, assetId: "stock", quantity: "1", price: "2" }),
      tx("b3", "2025-01-01", "BUY", { sequence: 3, assetId: "stock", quantity: "1", price: "3" }),
      tx("s1", "2025-01-02", "SELL", { assetId: "stock", quantity: "1", price: "4" }),
      tx("split", "2025-01-03", "SPLIT", { assetId: "stock", ratio: "0.333333333" }),
      tx("move", "2025-01-03", "TRANSFER", { sequence: 1, assetId: "stock", quantity: "0.666666666", toAccountId: "B" }),
      tx("s2", "2025-01-04", "SELL", { accountId: "B", assetId: "stock", quantity: "0.666666666", price: "12" }),
    ], [price("2025-01-01", "2"), price("2025-01-02", "4"), price("2025-01-03", "12")], {
      filters: { from: "2025-01-01", to: "2025-01-04", currency: "USD", accountIds: [], costMethod: "AVERAGE" },
    });
    expect(result.summary.costBasis).toBe("0");
    expect(result.summary.totalValue).toBe("11.999999992");
    near(result.summary.realizedPnl, 5.999999992);
    expect(result.trades.every(lot => lot.remainingQuantity === "0" && lot.status === "CLOSED")).toBe(true);
    expect(result.issues.some(issue => issue.code === "OVERSELL")).toBe(false);
  });

  it("accounts for standalone fees, taxes, net interest and deposit/withdrawal charges once", () => {
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "100", fee: "1" }),
      tx("i", "2025-01-02", "INTEREST", { amount: "10", fee: "1", tax: "2" }),
      tx("f", "2025-01-02", "FEE", { sequence: 1, amount: "3", tax: "1" }),
      tx("t", "2025-01-03", "TAX", { amount: "2", fee: "1" }),
      tx("w", "2025-01-04", "WITHDRAWAL", { amount: "20", fee: "1", tax: "1" }),
    ], []);
    // 99 + 7 - 4 - 3 - 22 = 77; external principal is 100 - 20 = 80.
    expect(result.summary).toMatchObject({
      totalValue: "77", netContributions: "80", totalPnl: "-3",
      interest: "7", fees: "7", taxes: "6",
    });
  });

  it("does not mutate the input ledger or use process-global Decimal state", async () => {
    const Decimal = (await import("decimal.js")).default;
    const oldPrecision = Decimal.precision;
    const input = structuredClone(transactions);
    for (const row of input) { Object.freeze(row.tags); Object.freeze(row); }
    Object.freeze(input);
    try {
      Decimal.set({ precision: 3 });
      expect(analyze(input, prices).summary.realizedPnl).toBe("206.8");
    } finally {
      Decimal.set({ precision: oldPrecision });
    }
  });
});

describe("corporate actions and custom assets", () => {
  it("accepts an absent or explicit zero split quantity, but rejects a conflicting nonzero quantity", () => {
    const opening = [
      tx("d", "2025-01-01", "DEPOSIT", { amount: "10" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "10" }),
    ];
    const split = tx("split", "2025-01-02", "SPLIT", { assetId: "stock", ratio: "2", quantity: "0" });
    expect(validateLedger([...opening, split], [stock], "FIFO")).toEqual([]);
    expect(validateLedger([...opening, { ...split, quantity: "2" }], [stock], "FIFO")
      .some(issue => issue.code === "INVALID_CORPORATE_ACTION")).toBe(true);
  });

  it.each(["FIFO", "AVERAGE"] as CostMethod[])("preserves costs through splits and reverse splits (%s)", costMethod => {
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "100" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "10", price: "10" }),
      tx("split", "2025-01-02", "SPLIT", { assetId: "stock", ratio: "2" }),
      tx("s", "2025-01-03", "SELL", { assetId: "stock", quantity: "5", price: "6" }),
      tx("reverse", "2025-01-04", "SPLIT", { assetId: "stock", ratio: "0.2" }),
    ], [price("2025-01-01", "10"), price("2025-01-02", "5"), price("2025-01-03", "6"), price("2025-01-04", "30")], {
      filters: { from: "2025-01-01", to: "2025-01-04", currency: "USD", accountIds: [], costMethod },
    });
    expect(result.history.map(point => point.value)).toEqual(["100", "100", "120", "120"]);
    expect(result.positions[0]).toMatchObject({ quantity: "3", costBasis: "75", averageCost: "25", unrealizedPnl: "15" });
    expect(result.summary.realizedPnl).toBe("5");
    expect(result.trades[0]).toMatchObject({ quantity: "4", remainingQuantity: "3", soldQuantity: "1" });
    near(result.summary.twr, 0.2);
  });

  it("uses CUSTOM valuation overrides as per-unit prices, never deposits or total value", () => {
    const custom = { ...stock, assetClass: "CUSTOM" as const };
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "100" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "2", price: "25" }),
      tx("v1", "2025-01-01", "VALUATION", { sequence: 2, assetId: "stock", price: "30" }),
      tx("v2", "2025-01-02", "VALUATION", { assetId: "stock", price: "40" }),
    ], [price("2025-01-02", "999")], {
      assets: [custom],
      filters: { from: "2025-01-02", to: "2025-01-02", currency: "USD", accountIds: [], costMethod: "FIFO" },
    });
    expect(result.summary).toMatchObject({
      openingValue: "110", totalValue: "130", totalPnl: "20",
      netContributions: "100", costBasis: "50", unrealizedPnl: "30", periodNetContributions: "0",
    });
    expect(result.provenance.find(row => row.kind === "PRICE" && row.asOf === "2025-01-02"))
      .toMatchObject({ value: "40", source: "MANUAL_VALUATION", transactionId: "v2" });
  });

  it("allows an explicit worthless custom valuation without mistaking zero for missing", () => {
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "10" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "10" }),
      tx("v", "2025-01-02", "VALUATION", { assetId: "stock", price: "0" }),
    ], [price("2025-01-01", "10")], {
      assets: [{ ...stock, assetClass: "CUSTOM" }],
      filters: { from: "2025-01-01", to: "2025-01-02", currency: "USD", accountIds: [], costMethod: "FIFO" },
    });
    expect(result.summary.totalValue).toBe("0");
    expect(result.summary.twr).toBe("-1");
    expect(result.summary.mdd).toBe("-1");
  });
});

describe("historical costs and reporting-currency FX", () => {
  it("uses trade-date FX for costs/proceeds, and current FX for NAV, including FX charges", () => {
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "100" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "2", price: "30", fee: "1", tax: "1" }),
      tx("fx", "2025-01-02", "FX", { amount: "10", fee: "1", tax: "1", toCurrency: "KRW", toAmount: "11000" }),
      tx("s", "2025-01-03", "SELL", { assetId: "stock", quantity: "1", price: "40", fee: "1", tax: "1" }),
    ], [price("2025-01-01", "30"), price("2025-01-02", "35"), price("2025-01-03", "40")], {
      fx: [fx("2025-01-01", "1000"), fx("2025-01-02", "1100"), fx("2025-01-03", "1200")],
      filters: { from: "2025-01-01", to: "2025-01-03", currency: "KRW", accountIds: [], costMethod: "FIFO" },
    });
    // Cost per unit = 31 USD at 1000; sale = 38 USD at 1200.
    // Cash is 64 USD at 1200 plus 11000 KRW; remaining stock is 40 USD at 1200.
    expect(result.positions[0]).toMatchObject({
      costBasis: "31", costBasisBase: "31000", value: "40", valueBase: "48000",
      unrealizedPnl: "9", unrealizedPnlBase: "17000", realizedPnlBase: "14600",
    });
    expect(result.summary).toMatchObject({
      totalValue: "135800", totalPnl: "35800", netContributions: "100000",
      realizedPnl: "14600", unrealizedPnl: "17000", fees: "3300", taxes: "3300",
    });
    expect(result.history.map(row => row.value)).toEqual(["98000", "116600", "135800"]);
    expect(result.cash).toEqual([
      { accountId: "A", currency: "KRW", balance: "11000", valueBase: "11000" },
      { accountId: "A", currency: "USD", balance: "64", valueBase: "76800" },
    ]);
  });

  it.each(["FIFO", "AVERAGE"] as CostMethod[])("maintains an independent historical report-currency pool (%s)", costMethod => {
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "100" }),
      tx("b1", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "10" }),
      tx("b2", "2025-01-02", "BUY", { assetId: "stock", quantity: "1", price: "20" }),
      tx("s", "2025-01-03", "SELL", { assetId: "stock", quantity: "1", price: "30" }),
    ], [price("2025-01-01", "10"), price("2025-01-02", "20"), price("2025-01-03", "30")], {
      fx: [fx("2025-01-01", "1000"), fx("2025-01-02", "2000"), fx("2025-01-03", "3000")],
      filters: { from: "2025-01-03", to: "2025-01-03", currency: "KRW", accountIds: [], costMethod },
    });
    expect(result.positions[0].costBasis).toBe(costMethod === "FIFO" ? "20" : "15");
    expect(result.positions[0].costBasisBase).toBe(costMethod === "FIFO" ? "40000" : "25000");
    expect(result.summary.realizedPnl).toBe(costMethod === "FIFO" ? "80000" : "65000");
    expect(result.summary.totalValue).toBe("390000");
  });

  it("selects the newest eligible FX observation, including inverse quotes", () => {
    const result = analyze([tx("d", "2025-01-02", "DEPOSIT", { amount: "1" })], [], {
      fx: [fx("2025-01-01", "1000"), { ...fx("2025-01-02", "0.0005"), base: "KRW", quote: "USD" }],
      filters: { from: "2025-01-02", to: "2025-01-02", currency: "KRW", accountIds: [], costMethod: "FIFO" },
    });
    expect(result.summary.totalValue).toBe("2000");
    expect(result.summary.netContributions).toBe("2000");
    expect(result.provenance.find(row => row.kind === "FX")).toMatchObject({ inverted: true, observedOn: "2025-01-02" });
  });

  it("selects data revisions by actual fetched instant, not timestamp spelling", () => {
    const observations = [
    { ...fx("2025-01-01", "1000"), fetchedAt: "2025-01-01T20:00:00+09:00" },
    { ...fx("2025-01-01", "1200"), fetchedAt: "2025-01-01T13:00:00Z" },
    ];
    const filters = { from: "2025-01-01", to: "2025-01-01", currency: "KRW" as const, accountIds: [], costMethod: "FIFO" as const };
    const result = analyze([tx("d", "2025-01-01", "DEPOSIT", { amount: "1" })], [], { fx: observations, filters });
    expect(result.summary.totalValue).toBe("1200");
    const reversed = analyze([tx("d", "2025-01-01", "DEPOSIT", { amount: "1" })], [], { fx: [...observations].reverse(), filters });
    expect(reversed.provenance).toEqual(result.provenance);
  });

  it("keeps economically neutral inception neutral with repeating inverse FX", () => {
    const result = analyze([
    tx("d", "2025-01-01", "DEPOSIT", { amount: "1" }),
    tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "0.6", price: "1" }),
    ], [price("2025-01-01", "1")], {
    fx: [{ ...fx("2025-01-01", "3"), base: "KRW", quote: "USD" }],
    filters: { from: "2025-01-01", to: "2025-01-01", currency: "KRW", accountIds: [], costMethod: "FIFO" },
    });
    expect(result.summary.twr).toBe("0");
    expect(result.issues.some(issue => issue.code === "UNDEFINED_ZERO_CAPITAL_RETURN")).toBe(false);
  });

  it("expires stale FX for an actual nonzero foreign cash balance", () => {
    const result = analyze([tx("d", "2025-01-01", "DEPOSIT", { amount: "1" })], [], {
    fx: [fx("2025-01-01", "1000")],
    filters: { from: "2025-01-08", to: "2025-01-09", currency: "KRW", accountIds: [], costMethod: "FIFO" },
    });
    expect(result.history.map(row => row.value)).toEqual(["1000", null]);
    expect(result.provenance.find(row => row.kind === "FX" && row.asOf === "2025-01-09"))
    .toMatchObject({ stale: true, usable: false, observedOn: "2025-01-01", ageDays: 8, value: "1000" });
    expect(result.issues.some(issue => issue.code === "STALE_FX")).toBe(true);
  });

  it("never backfills historical acquisition costs or deposits with future FX", () => {
    const transactions = [
      tx("d", "2025-01-01", "DEPOSIT", { amount: "2" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "1" }),
    ];
    expect(validateLedger(transactions, [stock], "FIFO")).toEqual([]);
    const result = analyze(transactions, [price("2025-01-02", "1")], {
      fx: [fx("2025-01-02", "2000")],
      filters: { from: "2025-01-01", to: "2025-01-02", currency: "KRW", accountIds: [], costMethod: "FIFO" },
    });
    expect(result.summary.totalValue).toBe("4000");
    expect(result.positions[0].costBasis).toBe("1");
    expect(result.positions[0].costBasisBase).toBeNull();
    expect(result.summary.netContributions).toBeNull();
    expect(result.summary.totalPnl).toBeNull();
    expect(result.summary.mwr.status).toBe("MISSING_DATA");
    expect(result.provenance.find(row => row.kind === "FX" && row.asOf === "2025-01-01"))
      .toMatchObject({ observedOn: null, value: null, usable: false });
  });
});

describe("single-record account transfers", () => {
  const transactions = [
    tx("d", "2025-01-01", "DEPOSIT", { amount: "1000" }),
    tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "10", price: "10" }),
    tx("cash", "2025-01-02", "TRANSFER", { amount: "200", toAccountId: "B", fee: "2", tax: "1" }),
    tx("asset", "2025-01-02", "TRANSFER", { sequence: 1, assetId: "stock", quantity: "4", toAccountId: "B" }),
  ];
  const prices = [price("2025-01-01", "10"), price("2025-01-02", "15"), price("2025-01-03", "20")];
  const run = (accountIds: string[]) => analyze(transactions, prices, {
    filters: { from: "2025-01-02", to: "2025-01-03", currency: "USD", accountIds, costMethod: "FIFO" },
  });

  it("nets internal cash and in-kind transfers to zero in consolidation", () => {
    const result = run([]);
    expect(result.summary).toMatchObject({
      totalValue: "1097", openingValue: "1000", totalPnl: "97", netContributions: "1000",
      periodNetContributions: "0", realizedPnl: "0", costBasis: "100", fees: "2", taxes: "1",
    });
    expect(result.history.map(row => row.externalFlow)).toEqual(["0", "0"]);
    expect(result.positions.map(position => [position.accountId, position.quantity, position.costBasis]))
      .toEqual([["A", "6", "60"], ["B", "4", "40"]]);
  });

  it("uses transfer-date FMV at each account boundary without resetting acquisition costs", () => {
    const source = run(["A"]);
    const destination = run(["B"]);
    expect(source.summary).toMatchObject({
      totalValue: "817", periodNetContributions: "-260", totalPnl: "77", netContributions: "740",
    });
    expect(destination.summary).toMatchObject({
      totalValue: "280", openingValue: "0", periodNetContributions: "260",
      netContributions: "260", totalPnl: "20", costBasis: "40", unrealizedPnl: "40",
    });
    expect(destination.history[0].externalFlow).toBe("260");
    near(destination.summary.twr, 20 / 260);
    expect(destination.trades[0]).toMatchObject({ acquisitionId: "b", openedOn: "2025-01-01", holdingDays: 2, remainingQuantity: "4", costBasisBase: "40" });
    expect(source.trades[0]).toMatchObject({ status: "PARTIAL", transferredQuantity: "4", realizedPnlBase: "0" });
  });

  it("preserves original FIFO priority after transfer into an account with newer purchases", () => {
    const result = analyze([
      tx("dA", "2025-01-01", "DEPOSIT", { amount: "100" }),
      tx("old", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "10", price: "10" }),
      tx("dB", "2025-01-02", "DEPOSIT", { accountId: "B", amount: "25" }),
      tx("new", "2025-01-02", "BUY", { accountId: "B", sequence: 1, assetId: "stock", quantity: "1", price: "25" }),
      tx("move", "2025-01-03", "TRANSFER", { assetId: "stock", quantity: "5", toAccountId: "B" }),
      tx("sale", "2025-01-04", "SELL", { accountId: "B", assetId: "stock", quantity: "1", price: "30" }),
    ], [price("2025-01-01", "10"), price("2025-01-02", "25"), price("2025-01-03", "27"), price("2025-01-04", "30")], {
      filters: { from: "2025-01-01", to: "2025-01-04", currency: "USD", accountIds: ["B"], costMethod: "FIFO" },
    });
    expect(result.positions[0]).toMatchObject({ quantity: "5", costBasis: "65", realizedPnlBase: "20" });
    expect(result.trades.find(lot => lot.acquisitionId === "old")).toMatchObject({ remainingQuantity: "4", realizedPnlBase: "20" });
    expect(result.trades.find(lot => lot.acquisitionId === "new")).toMatchObject({ remainingQuantity: "1", realizedPnlBase: "0" });
  });

  it.each([
    ["FIFO", "70", "80"], ["AVERAGE", "90", "60"],
  ] as const)("moves %s acquisition cohorts rather than creating zero-cost stock", (costMethod, destinationCost, sourceCost) => {
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "150" }),
      tx("b1", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "5", price: "10" }),
      tx("b2", "2025-01-02", "BUY", { assetId: "stock", quantity: "5", price: "20" }),
      tx("move", "2025-01-03", "TRANSFER", { assetId: "stock", quantity: "6", toAccountId: "B" }),
    ], [price("2025-01-01", "10"), price("2025-01-02", "20"), price("2025-01-03", "30")], {
      filters: { from: "2025-01-01", to: "2025-01-03", currency: "USD", accountIds: [], costMethod },
    });
    expect(result.positions.map(position => position.costBasis)).toEqual([sourceCost, destinationCost]);
    expect(result.summary.costBasis).toBe("150");
    expect(result.summary.realizedPnl).toBe("0");
  });

  it("preserves historical FX cost across a full in-kind transfer", () => {
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "10" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "10" }),
      tx("move", "2025-01-02", "TRANSFER", { assetId: "stock", quantity: "1", toAccountId: "B" }),
    ], [price("2025-01-01", "10"), price("2025-01-02", "20")], {
      fx: [fx("2025-01-01", "1000"), fx("2025-01-02", "1500")],
      filters: { from: "2025-01-02", to: "2025-01-02", currency: "KRW", accountIds: ["B"], costMethod: "FIFO" },
    });
    expect(result.summary).toMatchObject({
      totalValue: "30000", costBasis: "10000", netContributions: "30000",
      totalPnl: "0", unrealizedPnl: "20000", realizedPnl: "0",
    });
  });
});

describe("market-data availability, replay and validation", () => {
  it.each(["USD", "KRW"] as const)("serializes a funded but unpriced new position as null instead of throwing (%s report)", currency => {
    const result = analyze([
      tx("d", "2026-10-01", "DEPOSIT", { amount: "1000" }),
      tx("b", "2026-10-01", "BUY", { sequence: 1, assetId: "stock", quantity: "2", price: "100" }),
    ], [], {
      assets: [{ ...stock, symbol: "UITEST" }],
      filters: {
        from: "2026-10-01", to: "2026-10-02", currency,
        accountIds: ["A"], costMethod: "FIFO", benchmarkAssetId: "stock",
      },
    });
    expect(result.summary.totalValue).toBeNull();
    expect(result.summary.totalPnl).toBeNull();
    expect(result.summary.twr).toBeNull();
    expect(result.summary.mwr.status).toBe("MISSING_DATA");
    expect(result.positions[0]).toMatchObject({
      quantity: "2", costBasis: "200", value: null, valueBase: null,
      unrealizedPnlBase: null, weight: null,
    });
    expect(result.cash[0].balance).toBe("800");
    expect(result.trades[0]).toMatchObject({
      remainingQuantity: "2", returnRate: null, priceReturnRate: null, unrealizedPnlBase: null,
    });
    expect(result.benchmark).toMatchObject({
      returnRate: null, portfolioPriceReturn: null, cashflowValue: null, pnl: null,
    });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.issues.some(issue => issue.code === "MISSING_PRICE")).toBe(true);
  });

  it("never looks ahead for prices, and does not bridge a missing return interval", () => {
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "10" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "10" }),
    ], [price("2025-01-03", "12")]);
    expect(result.history[0].value).toBeNull();
    expect(result.history[1].value).toBeNull();
    expect(result.summary.totalValue).toBe("12");
    expect(result.summary.totalPnl).toBe("2");
    expect(result.summary.twr).toBeNull();
    expect(result.summary.mdd).toBeNull();
    expect(result.summary.mwr.status).toBe("CONVERGED");
    expect(result.provenance.find(row => row.asOf === "2025-01-01"))
      .toMatchObject({ observedOn: null, usable: false });
  });

  it("carries quotes for at most seven calendar days, retaining stale provenance thereafter", () => {
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "10" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "10" }),
    ], [price("2025-01-01", "10")], {
      fx: [fx("2025-01-01", "1000")],
      filters: { from: "2025-01-01", to: "2025-01-09", currency: "KRW", accountIds: [], costMethod: "FIFO" },
    });
    expect(result.history[7].value).toBe("10000");
    expect(result.history[8].value).toBeNull();
    expect(result.summary.totalValue).toBeNull();
    expect(result.provenance.find(row => row.kind === "PRICE" && row.asOf === "2025-01-09"))
      .toMatchObject({ observedOn: "2025-01-01", value: "10", ageDays: 8, carried: true, stale: true, usable: false });
    expect(result.issues.some(issue => issue.code === "CARRIED_FX" && issue.date === "2025-01-08")).toBe(true);
    expect(result.issues.some(issue => issue.code === "STALE_PRICE")).toBe(true);
  });

  it("rejects adjusted closes instead of double-counting corporate actions", () => {
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "10" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "10" }),
    ], [{ ...price("2025-01-01", "5"), adjustment: "ADJUSTED" as "RAW" }]);
    expect(result.summary.totalValue).toBeNull();
    expect(result.issues.some(issue => issue.code === "ADJUSTED_PRICE_REJECTED")).toBe(true);
  });

  it("replays pre-period balances and historical edits instead of rebasing costs or PnL", () => {
    const transactions = [
      tx("d", "2025-01-01", "DEPOSIT", { amount: "100" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "10", price: "10" }),
    ];
    const prices = [price("2025-01-02", "10"), price("2025-01-03", "12")];
    const filters = { from: "2025-01-03", to: "2025-01-03", currency: "USD" as const, accountIds: [], costMethod: "FIFO" as const };
    const original = analyze(transactions, prices, { filters });
    const edited = analyze([transactions[0], { ...transactions[1], quantity: "5" }], prices, { filters });
    expect(original.summary).toMatchObject({ openingValue: "100", totalValue: "120", totalPnl: "20", periodNetContributions: "0", netContributions: "100" });
    expect(edited.summary).toMatchObject({ openingValue: "100", totalValue: "110", totalPnl: "10", costBasis: "50" });
    expect(edited.cash[0].balance).toBe("50");
    expect(edited.trades[0].openedOn).toBe("2025-01-01");
  });

  it("keeps period PnL distinct from cumulative deposits and open-position lifetime gains", () => {
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "100" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "10", price: "8" }),
    ], [price("2025-01-02", "10"), price("2025-01-03", "12")], {
      filters: { from: "2025-01-03", to: "2025-01-03", currency: "USD", accountIds: [], costMethod: "FIFO" },
    });
    expect(result.summary).toMatchObject({
      openingValue: "120", totalValue: "140", totalPnl: "20",
      cumulativePnl: "40", netContributions: "100", periodNetContributions: "0", unrealizedPnl: "40",
    });
    near(result.summary.simpleReturn, 20 / 120);
  });

  it("does not require market prices for already liquidated opening balances", () => {
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "100" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "100" }),
      tx("s", "2025-01-02", "SELL", { assetId: "stock", quantity: "1", price: "120" }),
    ], [], {
      filters: { from: "2025-01-03", to: "2025-01-03", currency: "USD", accountIds: [], costMethod: "FIFO" },
    });
    expect(result.summary).toMatchObject({ openingValue: "120", totalValue: "120", totalPnl: "0", cumulativePnl: "20", realizedPnl: "0" });
    expect(result.issues).toEqual([]);
  });

  it("sorts by date and sequence, then ID, independent of input array order", () => {
    const transactions = [
      tx("d", "2025-01-01", "DEPOSIT", { amount: "20" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "10" }),
      tx("s", "2025-01-01", "SELL", { sequence: 2, assetId: "stock", quantity: "1", price: "11" }),
    ];
    expect(validateLedger([...transactions].reverse(), [stock], "FIFO")).toEqual([]);
    expect(analyze([...transactions].reverse(), []).summary).toEqual(analyze(transactions, []).summary);
  });

  it.each([
    ["NEGATIVE_CASH", [tx("bad", "2025-01-01", "BUY", { assetId: "stock", quantity: "1", price: "1" })]],
    ["OVERSELL", [tx("bad", "2025-01-01", "SELL", { assetId: "stock", quantity: "1", price: "1" })]],
    ["UNKNOWN_ASSET", [tx("bad", "2025-01-01", "SELL", { assetId: "missing", quantity: "1", price: "1" })]],
    ["INVALID_FX", [tx("bad", "2025-01-01", "FX", { amount: "1", toCurrency: "USD", toAmount: "1" })]],
    ["MISSING_OR_ZERO_AMOUNT", [tx("bad", "2025-01-01", "FX", { amount: "1", toCurrency: "KRW" })]],
    ["INVALID_TRANSFER", [tx("bad", "2025-01-01", "TRANSFER", { amount: "1", toAccountId: "A" })]],
    ["SPLIT_WITHOUT_HOLDING", [tx("bad", "2025-01-01", "SPLIT", { assetId: "stock", ratio: "2" })]],
    ["INVALID_VALUATION", [tx("bad", "2025-01-01", "VALUATION", { assetId: "stock", price: "2" })]],
    ["NEGATIVE_AMOUNT", [tx("bad", "2025-01-01", "DEPOSIT", { amount: "1", fee: "-1" })]],
    ["INVALID_DATE", [tx("bad", "2025-02-30", "DEPOSIT", { amount: "1" })]],
    ["INVALID_NUMBER", [tx("bad", "2025-01-01", "DEPOSIT", { amount: "NaN" })]],
    ["TRADE_AMOUNT_MISMATCH", [tx("bad", "2025-01-01", "BUY", { assetId: "stock", quantity: "2", price: "3", amount: "5" })]],
  ])("fails closed on %s without needing price or FX observations", (code, transactions) => {
    const issues = validateLedger(transactions, [stock], "FIFO");
    expect(issues.some(issue => issue.code === code && issue.severity === "error")).toBe(true);
    const result = analyze(transactions, []);
    expect(result.summary.totalValue).toBeNull();
    expect(result.positions).toEqual([]);
  });

  it("rejects transient negative balances even if a later deposit would cover them", () => {
    const transactions = [
      tx("b", "2025-01-01", "BUY", { assetId: "stock", quantity: "1", price: "1" }),
      tx("d", "2025-01-02", "DEPOSIT", { amount: "1" }),
    ];
    expect(validateLedger(transactions, [stock], "AVERAGE").some(issue => issue.code === "NEGATIVE_CASH")).toBe(true);
  });

  it("never credits the destination of an invalid transfer", () => {
    const result = validateLedger([
      tx("move", "2025-01-01", "TRANSFER", { amount: "10", toAccountId: "B" }),
      tx("withdraw", "2025-01-02", "WITHDRAWAL", { accountId: "B", amount: "10" }),
    ], [stock], "FIFO");
    expect(result.filter(issue => issue.code === "NEGATIVE_CASH").map(issue => issue.transactionId))
      .toEqual(["move", "withdraw"]);
  });

  it("rejects duplicate IDs, zero-ratio corporate actions and implicit FX transfers", () => {
    expect(validateLedger([
      tx("same", "2025-01-01", "DEPOSIT", { amount: "10" }),
      tx("same", "2025-01-02", "DEPOSIT", { amount: "10" }),
    ], [stock], "FIFO").some(issue => issue.code === "DUPLICATE_TRANSACTION")).toBe(true);
    expect(validateLedger([
      tx("split", "2025-01-01", "SPLIT", { assetId: "stock", ratio: "0" }),
    ], [stock], "FIFO").some(issue => issue.code === "MISSING_OR_ZERO_AMOUNT")).toBe(true);
    expect(validateLedger([
      tx("move", "2025-01-01", "TRANSFER", { amount: "10", toAccountId: "B", toCurrency: "KRW" }),
    ], [stock], "FIFO").some(issue => issue.code === "INVALID_TRANSFER")).toBe(true);
  });

  it("does not retroactively invalidate a historical report because of future transactions", () => {
    const result = analyze([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "10" }),
      tx("future", "2026-01-01", "WITHDRAWAL", { amount: "100" }),
    ], []);
    expect(result.summary.totalValue).toBe("10");
    expect(result.issues).toEqual([]);
  });
});
