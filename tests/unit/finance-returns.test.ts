import { describe, expect, it } from "vitest";
import {
  analyzePortfolio, calculateXirr, projectGoal, projectGoalDetails,
  type AnalysisInput, type AssetInput, type LedgerTransaction, type PriceInput,
} from "../../src/lib/finance";

const stock: AssetInput = {
  id: "stock", symbol: "STK", name: "Stock", exchange: "TEST", currency: "USD",
  assetClass: "STOCK", country: null, sector: null,
};
const benchmark: AssetInput = { ...stock, id: "benchmark", symbol: "BENCH", assetClass: "ETF" };
const tx = (id: string, date: string, kind: LedgerTransaction["kind"], fields: Partial<LedgerTransaction> = {}): LedgerTransaction => ({
  id, date, kind, accountId: "A", currency: "USD", sequence: 0, fee: "0", tax: "0", memo: "", tags: [], ...fields,
});
const price = (date: string, close: string, assetId = "stock"): PriceInput => ({
  assetId, date, close, currency: "USD", source: "fixture", adjustment: "RAW", fetchedAt: `${date}T18:00:00Z`,
});
function run(transactions: LedgerTransaction[], prices: PriceInput[], overrides: Partial<AnalysisInput> = {}) {
  return analyzePortfolio({
    transactions, prices, assets: [stock, benchmark], fx: [],
    filters: { from: "2025-01-01", to: "2025-01-03", currency: "USD", accountIds: [], costMethod: "FIFO" },
    ...overrides,
  });
}
function near(actual: string | null, expected: number, digits = 10) {
  expect(actual).not.toBeNull();
  expect(Number(actual)).toBeCloseTo(expected, digits);
}

describe("end-of-day portfolio return conventions", () => {
  it("distinguishes TWR, simple return, annual MWR and cumulative MWR under mid-period funding", () => {
    const prices: PriceInput[] = [];
    for (let stamp = Date.UTC(2021, 0, 1); stamp <= Date.UTC(2023, 0, 1); stamp += 86_400_000) {
      const date = new Date(stamp).toISOString().slice(0, 10);
      prices.push(price(date, date < "2022-01-01" ? "100" : "200"));
    }
    const result = run([
      tx("d1", "2021-01-01", "DEPOSIT", { amount: "100" }),
      tx("b1", "2021-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "100" }),
      tx("d2", "2022-01-01", "DEPOSIT", { amount: "200" }),
      tx("b2", "2022-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "200" }),
    ], prices, {
      filters: { from: "2021-01-01", to: "2023-01-01", currency: "USD", accountIds: [], costMethod: "FIFO" },
    });
    // Two exact 365-day investment intervals:
    // -100 - 200/(1+r) + 400/(1+r)^2 = 0 -> r = sqrt(5) - 2.
    expect(result.summary).toMatchObject({ totalValue: "400", totalPnl: "100", netContributions: "300", twr: "1" });
    near(result.summary.simpleReturn, 1 / 3);
    expect(result.summary.mwr.status).toBe("CONVERGED");
    near(result.summary.mwr.value, Math.sqrt(5) - 2);
    near(result.summary.mwr.cumulative, 5 - 2 * Math.sqrt(5));
    expect(result.summary.mwr.days).toBe(730);
    near(result.summary.twrAnnualized, Math.pow(2, 365 / 731) - 1);
    const fundedDay = result.history.find(row => row.date === "2022-01-01")!;
    expect(fundedDay).toMatchObject({ value: "400", externalFlow: "200", profit: "100", twr: "1" });
  });

  it("measures drawdown on unitized wealth rather than a NAV increase caused by a deposit", () => {
    const result = run([
      tx("d1", "2025-01-01", "DEPOSIT", { amount: "100" }),
      tx("b1", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "100" }),
      tx("d2", "2025-01-02", "DEPOSIT", { amount: "100" }),
      tx("w", "2025-01-03", "WITHDRAWAL", { amount: "100" }),
    ], [price("2025-01-01", "100"), price("2025-01-02", "80"), price("2025-01-03", "90")]);
    expect(result.history.map(row => row.value)).toEqual(["100", "180", "90"]);
    expect(result.history.map(row => row.externalFlow)).toEqual(["100", "100", "-100"]);
    near(result.summary.mdd, -0.2);
    near(result.summary.twr, -7 / 45);
    expect(result.summary.simpleReturnCapital).toBe("200");
    near(result.summary.simpleReturn, -0.05);
  });

  it("does not invent an inception-day return when fees occur against zero opening capital", () => {
    const result = run([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "100" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "99", fee: "1" }),
    ], [price("2025-01-01", "99")], {
      filters: { from: "2025-01-01", to: "2025-01-01", currency: "USD", accountIds: [], costMethod: "FIFO" },
    });
    expect(result.summary.totalPnl).toBe("-1");
    expect(result.summary.simpleReturn).toBe("-0.01");
    expect(result.summary.twr).toBeNull();
    expect(result.summary.mdd).toBeNull();
    expect(result.summary.mwr.status).toBe("NO_SOLUTION");
    expect(result.issues.some(issue => issue.code === "UNDEFINED_ZERO_CAPITAL_RETURN")).toBe(true);
  });

  it("returns true zero balances, but undefined investment returns, for an empty portfolio", () => {
    const result = run([], []);
    expect(result.summary.totalValue).toBe("0");
    expect(result.summary.netContributions).toBe("0");
    expect(result.summary.simpleReturn).toBeNull();
    expect(result.summary.twr).toBeNull();
    expect(result.summary.mdd).toBeNull();
    expect(result.summary.mwr.status).toBe("NO_SOLUTION");
  });

  it("supports full liquidation and a later neutral funding day without a fictitious loss", () => {
    const result = run([
      tx("d1", "2025-01-01", "DEPOSIT", { amount: "100" }),
      tx("w", "2025-01-02", "WITHDRAWAL", { amount: "100" }),
      tx("d2", "2025-01-03", "DEPOSIT", { amount: "200" }),
    ], []);
    expect(result.summary.twr).toBe("0");
    expect(result.summary.mdd).toBe("0");
    expect(result.history.map(row => row.dailyReturn)).toEqual(["0", "0", "0"]);
  });
});

describe("bracketed ACT/365 money-weighted return", () => {
  it("solves an independently known annual return and exposes its annual/cumulative units", () => {
    const result = calculateXirr([
      { date: "2021-01-01", amount: "-100" },
      { date: "2022-01-01", amount: "110" },
    ]);
    expect(result.status).toBe("CONVERGED");
    expect(result.days).toBe(365);
    near(result.value, 0.1);
    near(result.annualized, 0.1);
    near(result.cumulative, 0.1);
  });

  it("handles fractional years with ACT/365 rather than relabelling cumulative gain as annual", () => {
    const result = calculateXirr([
      { date: "2025-01-01", amount: "-100" },
      { date: "2025-07-02", amount: "110" },
    ]);
    expect(result.days).toBe(182);
    near(result.value, Math.pow(1.1, 365 / 182) - 1);
    near(result.cumulative, 0.1);
  });

  it("scans for multiple roots instead of returning whichever Newton iteration finds", () => {
    const result = calculateXirr([
      { date: "2021-01-01", amount: "-100" },
      { date: "2022-01-01", amount: "230" },
      { date: "2023-01-01", amount: "-132" },
    ]);
    // -100*x^2 + 230*x - 132 = -100*(x-1.1)*(x-1.2).
    expect(result.status).toBe("MULTIPLE_ROOTS");
    expect(result.value).toBeNull();
    expect(result.annualized).toBeNull();
    expect(result.cumulative).toBeNull();
    expect(result.roots).toHaveLength(2);
    near(result.roots[0], 0.1);
    near(result.roots[1], 0.2);
  });

  it("detects tangent roots as well as sign-changing roots", () => {
    const result = calculateXirr([
      { date: "2021-01-01", amount: "-100" },
      { date: "2022-01-01", amount: "200" },
      { date: "2023-01-01", amount: "-100" },
    ]);
    expect(result.status).toBe("CONVERGED");
    near(result.value, 0);
    expect(result.roots).toHaveLength(1);
  });

  it("detects nonzero tangent roots between scan samples", () => {
    const result = calculateXirr([
      { date: "2021-01-01", amount: "-100" },
      { date: "2022-01-01", amount: "220" },
      { date: "2023-01-01", amount: "-121" },
    ]);
    expect(result.status).toBe("CONVERGED");
    near(result.value, 0.1);
    expect(result.roots).toHaveLength(1);
  });

  it("aggregates same-day flows and is independent of input ordering", () => {
    const result = calculateXirr([
      { date: "2022-01-01", amount: "110" },
      { date: "2021-01-01", amount: "-120" },
      { date: "2021-01-01", amount: "20" },
      { date: "2021-04-01", amount: "0" },
    ]);
    expect(result.status).toBe("CONVERGED");
    near(result.value, 0.1);
  });

  it.each([
    [],
    [{ date: "2021-01-01", amount: "-100" }],
    [{ date: "2021-01-01", amount: "-100" }, { date: "2021-01-01", amount: "110" }],
    [{ date: "2021-01-01", amount: "-100" }, { date: "2022-01-01", amount: "50" }, { date: "2023-01-01", amount: "-100" }],
  ].map(cashflows => [cashflows] as const))("reports no solution for an unidentifiable or rootless cash-flow pattern: %j", cashflows => {
    const result = calculateXirr(cashflows);
    expect(result.status).toBe("NO_SOLUTION");
    expect(result.value).toBeNull();
  });

  it("does not silently publish an unconverged iterate", () => {
    const result = calculateXirr([
      { date: "2021-01-01", amount: "-100" }, { date: "2022-01-01", amount: "107" },
    ], { maxIterations: 1 });
    expect(result.status).toBe("NON_CONVERGENT");
    expect(result.value).toBeNull();
    expect(result.iterations).toBeGreaterThan(0);
  });

  it("reports invalid inputs rather than propagating NaN or Infinity", () => {
    expect(calculateXirr([{ date: "2025-02-30", amount: "-1" }]).status).toBe("INVALID_INPUT");
    expect(calculateXirr([{ date: "2025-01-01", amount: "Infinity" }]).status).toBe("INVALID_INPUT");
    expect(calculateXirr([], { minLogGrowth: 10, maxLogGrowth: -10 }).status).toBe("INVALID_INPUT");
  });
});

describe("same-period PRICE benchmarks and identical-flow virtual investment", () => {
  it("invests the exact portfolio flows at their own closing benchmark prices", () => {
    const result = run([
      tx("d1", "2025-01-01", "DEPOSIT", { amount: "100" }),
      tx("b1", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "100" }),
      tx("d2", "2025-01-02", "DEPOSIT", { amount: "110" }),
      tx("b2", "2025-01-02", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "110" }),
    ], [
      price("2025-01-01", "100"), price("2025-01-02", "110"), price("2025-01-03", "121"),
      price("2024-12-31", "10", "benchmark"), price("2025-01-01", "10", "benchmark"),
      price("2025-01-02", "20", "benchmark"), price("2025-01-03", "30", "benchmark"),
    ], {
      filters: { from: "2025-01-01", to: "2025-01-03", currency: "USD", accountIds: [], costMethod: "FIFO", benchmarkAssetId: "benchmark" },
    });
    // 100/10 = 10 units, then 110/20 = 5.5 units; 15.5*30 = 465.
    expect(result.benchmark).toEqual({
      assetId: "benchmark", returnType: "PRICE", from: "2024-12-31", to: "2025-01-03",
      returnRate: "2", portfolioPriceReturn: "0.21", cashflowValue: "465", pnl: "255",
    });
    expect(result.history.map(row => row.benchmarkValue)).toEqual(["100", "310", "465"]);
    expect(result.summary.totalValue).toBe("242");
    near(result.summary.twr, 0.21);
  });

  it("compares flat PRICE performance on the same dividend-excluded basis while displaying total 10% separately", () => {
    const result = run([
      tx("d", "2024-12-31", "DEPOSIT", { amount: "100" }),
      tx("b", "2024-12-31", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "100" }),
      tx("div", "2025-01-01", "DIVIDEND", { assetId: "stock", amount: "10" }),
    ], [price("2024-12-31", "100"), price("2025-01-01", "100")], {
      filters: { from: "2025-01-01", to: "2025-01-01", currency: "USD", accountIds: [], costMethod: "FIFO", benchmarkAssetId: "stock" },
    });
    // Actual wealth 110 = unchanged stock 100 + dividend cash 10.
    // Total TWR: 110/100 - 1 = 10%. PRICE basis: (110-10)/100 - 1 = 0%.
    expect(result.summary).toMatchObject({
      totalValue: "110", totalPnl: "10", dividends: "10", twr: "0.1",
      netContributions: "100", periodNetContributions: "0",
    });
    expect(result.history[0]).toMatchObject({
      value: "110", externalFlow: "0", netContributions: "100", twr: "0.1", portfolioPriceTwr: "0",
    });
    expect(result.benchmark).toMatchObject({
      returnType: "PRICE", returnRate: "0", portfolioPriceReturn: "0", cashflowValue: "100", pnl: "0",
    });
    expect(result.trades[0]).toMatchObject({ returnRate: "0.1", priceReturnRate: "0", benchmarkReturn: "0" });
  });

  it("excludes actual net dividends, not gross distributions, and never invests them as true benchmark flows", () => {
    const result = run([
      tx("d", "2024-12-31", "DEPOSIT", { amount: "100" }),
      tx("b", "2024-12-31", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "100" }),
      tx("div", "2025-01-01", "DIVIDEND", { assetId: "stock", amount: "13", tax: "2", fee: "1" }),
      tx("new-cash", "2025-01-01", "DEPOSIT", { sequence: 1, amount: "50" }),
    ], [price("2024-12-31", "100"), price("2025-01-01", "100")], {
      filters: { from: "2025-01-01", to: "2025-01-01", currency: "USD", accountIds: [], costMethod: "FIFO", benchmarkAssetId: "stock" },
    });
    // Net dividend 13-2-1=10. True flow 50; comparative flow 50+10.
    // Virtual units receive only the true 50 contribution, not the dividend.
    expect(result.summary).toMatchObject({
      totalValue: "160", twr: "0.1", netContributions: "150",
      periodNetContributions: "50", dividends: "10", grossDividends: "13",
    });
    expect(result.history[0]).toMatchObject({ externalFlow: "50", portfolioPriceTwr: "0" });
    expect(result.benchmark).toMatchObject({ portfolioPriceReturn: "0", cashflowValue: "150", pnl: "0" });
  });

  it("chains the price-basis path using actual prior NAV, including retained dividend cash", () => {
    const result = run([
      tx("d", "2024-12-31", "DEPOSIT", { amount: "100" }),
      tx("b", "2024-12-31", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "100" }),
      tx("div", "2025-01-01", "DIVIDEND", { assetId: "stock", amount: "10" }),
    ], [price("2024-12-31", "100"), price("2025-01-01", "110"), price("2025-01-02", "121")], {
      filters: { from: "2025-01-01", to: "2025-01-02", currency: "USD", accountIds: [], costMethod: "FIFO", benchmarkAssetId: "stock" },
    });
    // First day's PRICE factor 110/100; second day's factor 131/120.
    // Dividend cash remains in the actual portfolio and dilutes subsequent stock exposure.
    near(result.summary.twr, 0.31);
    expect(result.history[0].portfolioPriceTwr).toBe("0.1");
    near(result.benchmark!.portfolioPriceReturn, 0.2008333333333333333333);
    expect(result.benchmark!.returnRate).toBe("0.21");
    expect(result.benchmark!.cashflowValue).toBe("121");
  });

  it("excludes dividend cash at payment-date reporting FX while retaining comparable currency price gains", () => {
    const result = run([
      tx("d", "2024-12-31", "DEPOSIT", { amount: "100" }),
      tx("b", "2024-12-31", "BUY", { sequence: 1, assetId: "stock", quantity: "1", price: "100" }),
      tx("div", "2025-01-01", "DIVIDEND", { assetId: "stock", amount: "10" }),
    ], [price("2024-12-31", "100"), price("2025-01-01", "100")], {
      fx: [
        { date: "2024-12-31", base: "USD", quote: "KRW", rate: "1000", source: "fixture", fetchedAt: "2024-12-31T18:00:00Z" },
        { date: "2025-01-01", base: "USD", quote: "KRW", rate: "1200", source: "fixture", fetchedAt: "2025-01-01T18:00:00Z" },
      ],
      filters: { from: "2025-01-01", to: "2025-01-01", currency: "KRW", accountIds: [], costMethod: "FIFO", benchmarkAssetId: "stock" },
    });
    // 110 USD*1200 = 132000; remove dividend 10 USD*1200 = 12000.
    expect(result.summary).toMatchObject({ openingValue: "100000", totalValue: "132000", dividends: "12000", twr: "0.32" });
    expect(result.benchmark).toMatchObject({
      portfolioPriceReturn: "0.2", returnRate: "0.2", cashflowValue: "120000", pnl: "20000",
    });
  });

  it("includes reporting-currency FX in both benchmark endpoints and virtual NAV", () => {
    const dates = ["2024-12-31", "2025-01-01", "2025-01-02", "2025-01-03"];
    const result = run([tx("d", "2024-12-31", "DEPOSIT", { amount: "100" })],
      dates.map(date => price(date, "10", "benchmark")), {
        fx: dates.map((date, index) => ({
          date, base: "USD", quote: "KRW", rate: ["1000", "1000", "1100", "1200"][index],
          source: "fixture", fetchedAt: `${date}T18:00:00Z`,
        })),
        filters: { from: "2025-01-01", to: "2025-01-03", currency: "KRW", accountIds: [], costMethod: "FIFO", benchmarkAssetId: "benchmark" },
      });
    expect(result.benchmark).toMatchObject({ returnType: "PRICE", returnRate: "0.2", cashflowValue: "120000", pnl: "20000" });
    expect(result.summary.totalValue).toBe("120000");
  });

  it("matches partial lot disposals to their actual dates rather than using today's benchmark for sold units", () => {
    const result = run([
      tx("d", "2025-01-01", "DEPOSIT", { amount: "100" }),
      tx("b", "2025-01-01", "BUY", { sequence: 1, assetId: "stock", quantity: "2", price: "10" }),
      tx("s", "2025-01-02", "SELL", { assetId: "stock", quantity: "1", price: "15" }),
    ], [
      price("2025-01-01", "10"), price("2025-01-02", "15"), price("2025-01-03", "20"),
      price("2024-12-31", "90", "benchmark"), price("2025-01-01", "100", "benchmark"),
      price("2025-01-02", "110", "benchmark"), price("2025-01-03", "130", "benchmark"),
    ], {
      filters: { from: "2025-01-01", to: "2025-01-03", currency: "USD", accountIds: [], costMethod: "FIFO", benchmarkAssetId: "benchmark" },
    });
    expect(result.trades[0]).toMatchObject({
      status: "PARTIAL", realizedPnlBase: "5", unrealizedPnlBase: "10",
      returnRate: "0.75", benchmarkReturn: "0.2",
    });
  });

  it("keeps price return missing when the opening endpoint is missing, even if later cashflows can be invested", () => {
    const result = run([tx("d", "2025-01-01", "DEPOSIT", { amount: "100" })], [
      price("2025-01-01", "100", "benchmark"), price("2025-01-03", "110", "benchmark"),
    ], {
      filters: { from: "2025-01-01", to: "2025-01-03", currency: "USD", accountIds: [], costMethod: "FIFO", benchmarkAssetId: "benchmark" },
    });
    expect(result.benchmark?.returnRate).toBeNull();
    expect(result.benchmark?.cashflowValue).toBe("110");
    expect(result.issues.some(issue => issue.code === "MISSING_PRICE" && issue.date === "2024-12-31")).toBe(true);
  });

  it("does not fabricate benchmark borrowing when identical withdrawals exceed virtual capital", () => {
    const result = run([
      tx("d", "2024-12-31", "DEPOSIT", { amount: "100" }),
      tx("w", "2025-01-01", "WITHDRAWAL", { amount: "75" }),
    ], [price("2024-12-31", "100", "benchmark"), price("2025-01-01", "50", "benchmark")], {
      filters: { from: "2025-01-01", to: "2025-01-01", currency: "USD", accountIds: [], costMethod: "FIFO", benchmarkAssetId: "benchmark" },
    });
    expect(result.summary.totalValue).toBe("25");
    expect(result.benchmark?.returnRate).toBe("-0.5");
    expect(result.benchmark?.cashflowValue).toBeNull();
    expect(result.benchmark?.pnl).toBeNull();
    expect(result.issues.some(issue => issue.code === "BENCHMARK_NEGATIVE_CAPITAL")).toBe(true);
  });

  it("does not use future benchmark prices to invest a flow on a stale-price day", () => {
    const result = run([
      tx("d1", "2025-01-01", "DEPOSIT", { amount: "100" }),
      tx("d2", "2025-01-10", "DEPOSIT", { amount: "100" }),
    ], [
      price("2024-12-31", "10", "benchmark"), price("2025-01-01", "10", "benchmark"),
      price("2025-01-11", "20", "benchmark"),
    ], {
      filters: { from: "2025-01-01", to: "2025-01-11", currency: "USD", accountIds: [], costMethod: "FIFO", benchmarkAssetId: "benchmark" },
    });
    expect(result.benchmark?.returnRate).toBe("1");
    expect(result.benchmark?.cashflowValue).toBeNull();
    expect(result.issues.some(issue => issue.code === "BENCHMARK_FLOW_PRICE_MISSING" && issue.date === "2025-01-10")).toBe(true);
  });

  it("adjusts benchmark units for RAW-price splits once, not once per account", () => {
    const transactions: LedgerTransaction[] = [];
    for (const accountId of ["A", "B"]) {
      transactions.push(
        tx(`d${accountId}`, "2024-12-31", "DEPOSIT", { accountId, amount: "100" }),
        tx(`b${accountId}`, "2024-12-31", "BUY", { accountId, sequence: 1, assetId: "stock", quantity: "1", price: "100" }),
        tx(`split${accountId}`, "2025-01-01", "SPLIT", { accountId, assetId: "stock", ratio: "2" }),
      );
    }
    const result = run(transactions, [
      price("2024-12-31", "100"), price("2025-01-01", "50"), price("2025-01-02", "55"),
    ], {
      filters: { from: "2025-01-01", to: "2025-01-02", currency: "USD", accountIds: [], costMethod: "FIFO", benchmarkAssetId: "stock" },
    });
    expect(result.summary.totalValue).toBe("220");
    expect(result.benchmark).toMatchObject({
      returnRate: "0.1", portfolioPriceReturn: "0.1", cashflowValue: "220", pnl: "20",
    });
    expect(result.history.map(point => point.portfolioPriceTwr)).toEqual(["0", "0.1"]);
  });

  it("reports incompatible account split events instead of inventing a benchmark split adjustment", () => {
    const transactions: LedgerTransaction[] = [];
    for (const accountId of ["A", "B"]) {
      transactions.push(
        tx(`d${accountId}`, "2024-12-31", "DEPOSIT", { accountId, amount: "100" }),
        tx(`b${accountId}`, "2024-12-31", "BUY", { accountId, sequence: 1, assetId: "stock", quantity: "1", price: "100" }),
        tx(`split${accountId}`, "2025-01-01", "SPLIT", { accountId, assetId: "stock", ratio: accountId === "A" ? "2" : "3" }),
      );
    }
    const result = run(transactions, [price("2024-12-31", "100"), price("2025-01-01", "50")], {
      filters: { from: "2025-01-01", to: "2025-01-01", currency: "USD", accountIds: [], costMethod: "FIFO", benchmarkAssetId: "stock" },
    });
    expect(result.benchmark!.returnRate).toBeNull();
    expect(result.benchmark!.cashflowValue).toBeNull();
    expect(result.benchmark!.pnl).toBeNull();
    expect(result.issues.some(issue => issue.code === "AMBIGUOUS_BENCHMARK_SPLIT")).toBe(true);
  });
});

describe("Decimal goal projections", () => {
  it("returns the frozen yearly-array contract, including year zero", () => {
    const result = projectGoal({ initial: "100", monthlyContribution: "10", annualReturn: "0", years: 2 });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      { year: 0, value: "100", contributions: "100" },
      { year: 1, value: "220", contributions: "220" },
      { year: 2, value: "340", contributions: "340" },
    ]);
    expect(projectGoal({ initial: "100", monthlyContribution: "10", annualReturn: "0.07", years: 0 }))
      .toMatchObject([{ year: 0, value: "100", contributions: "100" }]);
  });

  it("uses end-of-month contributions with no growth when the return is zero", () => {
    const result = projectGoalDetails({ initial: "100", monthlyContribution: "10", annualReturn: "0", years: 1 });
    expect(result).toMatchObject({ finalValue: "220", totalContributions: "220", totalGrowth: "0", monthlyRate: "0", issues: [] });
    expect(result.monthly).toHaveLength(13);
    expect(result.yearly.map(row => row.value)).toEqual(["100", "220"]);
  });

  it("converts annual effective yield to a monthly rate rather than dividing it by twelve", () => {
    const result = projectGoalDetails({
      initial: "100", monthlyContribution: "10", annualReturn: "0.126825030131969720661201", years: 1,
    });
    // Given annual growth 1.01^12, FV = 100*1.01^12 + 10*(1.01^12-1)/0.01.
    near(result.monthlyRate, 0.01);
    near(result.finalValue, 239.5075331451666927273211);
    expect(result.totalContributions).toBe("220");
    near(result.totalGrowth, 19.5075331451666927273211);
  });

  it("supports zero years and an explicit total-loss scenario", () => {
    expect(projectGoalDetails({ initial: "100", monthlyContribution: "10", annualReturn: "0.07", years: 0 }).finalValue).toBe("100");
    expect(projectGoalDetails({ initial: "100", monthlyContribution: "10", annualReturn: "-1", years: 1 }))
      .toMatchObject({ finalValue: "10", totalContributions: "220", totalGrowth: "-210", monthlyRate: "-1" });
  });

  it.each([
    { initial: "-1", monthlyContribution: "10", annualReturn: "0.1", years: 1 },
    { initial: "1", monthlyContribution: "-10", annualReturn: "0.1", years: 1 },
    { initial: "1", monthlyContribution: "10", annualReturn: "-1.1", years: 1 },
    { initial: "1", monthlyContribution: "10", annualReturn: "0.1", years: 1.5 },
  ])("reports invalid projections as null, not as fabricated zero balances (%j)", input => {
    const result = projectGoalDetails(input);
    expect(result.finalValue).toBeNull();
    expect(result.monthly).toEqual([]);
    expect(result.issues[0].code).toBe("INVALID_PROJECTION");
    expect(projectGoal(input)).toEqual([]);
  });
});
