import type { AnalysisFilters, DataIssue } from "../domain";
import { Decimal, Issues, ONE, ZERO, add, daysBetween, mul, shiftDate, sub, text, validDate, type D, type MaybeD } from "./decimal";
import { Ledger } from "./ledger";
import { Market } from "./market";
import { annualize, calculateXirr, endOfDayReturn, unavailableXirr } from "./returns";
import type { AnalysisInput, AnalysisResult, BenchmarkResult, HistoryPoint, XirrCashFlow } from "./types";
import { checkBalances, isCurrency, prepareLedger } from "./validation";

function invalidResult(filters: AnalysisFilters, issues: DataIssue[]): AnalysisResult {
  const openingDate = validDate(filters.from) ? shiftDate(filters.from, -1) : "";
  return {
    filters,
    summary: {
      totalValue: null, costBasis: null, realizedPnl: null, unrealizedPnl: null,
      totalPnl: null, netContributions: null, dividends: null, grossDividends: null,
      interest: null, fees: null, taxes: null, simpleReturn: null, simpleReturnCapital: null,
      twr: null, twrAnnualized: null, mdd: null, openingValue: null,
      periodNetContributions: null, cumulativePnl: null,
      mwr: unavailableXirr("INVALID_INPUT", "Fix ledger or filter errors before calculating performance."),
    },
    history: [], positions: [], cash: [], trades: [], issues, provenance: [],
    benchmark: filters.benchmarkAssetId ? {
      assetId: filters.benchmarkAssetId, returnType: "PRICE", from: openingDate,
      to: filters.to, returnRate: null, portfolioPriceReturn: null, cashflowValue: null, pnl: null,
    } : null,
    openingDate,
    calculationPolicy: "END_OF_DAY_V1",
  };
}

export function analyzePortfolio(input: AnalysisInput): AnalysisResult {
  const { transactions, assets, prices, fx, filters } = input;
  const issues = new Issues();
  if (!validDate(filters.from) || !validDate(filters.to) || filters.from > filters.to ||
    (validDate(filters.from) && validDate(filters.to) && daysBetween(filters.from, filters.to) > 36_525)) {
    issues.add({ code: "INVALID_PERIOD", message: "Use an ordered YYYY-MM-DD date range no longer than 100 years.", severity: "error" });
  }
  if (!isCurrency(filters.currency) || !Array.isArray(filters.accountIds) ||
    filters.accountIds.some(account => typeof account !== "string" || !account.trim())) {
    issues.add({ code: "INVALID_FILTER", message: "Use a supported reporting currency and an array of account IDs (empty means all accounts).", severity: "error" });
  }
  if (issues.values.length) return invalidResult(filters, issues.values);
  const parsed = prepareLedger(
    transactions.filter(tx => !validDate(tx.date) || tx.date <= filters.to),
    assets, filters.costMethod, issues,
  );
  checkBalances(parsed, issues);
  if (issues.values.some(issue => issue.severity === "error")) return invalidResult(filters, issues.values);

  const openingDate = shiftDate(filters.from, -1);
  const market = new Market(assets, prices, fx, parsed, issues, filters.to);
  const ledger = new Ledger(market, filters);
  let cursor = 0;
  while (cursor < parsed.length && parsed[cursor].raw.date < filters.from) ledger.apply(parsed[cursor++]);
  const opening = ledger.snapshot(openingDate).total;
  let previous = opening;
  let index = ONE;
  let peak = ONE;
  let maxDrawdown = ZERO;
  let pathValid = opening !== null;
  let funded = opening !== null && opening.gt(0);
  let priceIndex = ONE;
  let pricePathValid = opening !== null;
  let priceFunded = funded;
  let finalSnapshot = ledger.snapshot(openingDate);
  const history: HistoryPoint[] = [];
  const investorFlows: XirrCashFlow[] = opening === null || opening.isZero()
    ? [] : [{ date: openingDate, amount: text(opening.negated())! }];
  let missingCashflow = opening === null;
  const benchmarkId = filters.benchmarkAssetId ?? null;
  if (benchmarkId && !market.assets.has(benchmarkId)) {
    issues.add({ code: "UNKNOWN_BENCHMARK", message: "The selected benchmark asset does not exist.", assetId: benchmarkId, severity: "error" });
  }
  const benchmarkStart = benchmarkId ? market.priceBase(benchmarkId, openingDate, filters.currency) : null;
  let benchmarkUnits: MaybeD = !benchmarkId || opening === null ? null :
    opening.isZero() ? ZERO :
      benchmarkStart !== null && benchmarkStart.gt(0) ? opening.div(benchmarkStart) : null;
  if (benchmarkId && benchmarkStart !== null && !benchmarkStart.gt(0)) {
    issues.add({ code: "BENCHMARK_ZERO_PRICE", message: "A zero opening benchmark price cannot define a price return or fund virtual units.", date: openingDate, assetId: benchmarkId, severity: "error" });
  }
  let benchmarkValue: MaybeD = null;
  let benchmarkReturn: MaybeD = null;
  const count = daysBetween(filters.from, filters.to) + 1;

  for (let day = 0; day < count; day++) {
    const date = shiftDate(filters.from, day);
    while (cursor < parsed.length && parsed[cursor].raw.date === date) ledger.apply(parsed[cursor++]);
    const snapshot = ledger.snapshot(date);
    finalSnapshot = snapshot;
    const flow = ledger.dailyFlows.has(date) ? ledger.dailyFlows.get(date)! : ZERO;
    const profit = sub(sub(snapshot.total, opening), ledger.periodContributions);
    if (flow === null) missingCashflow = true;
    else if (!flow.isZero()) investorFlows.push({ date, amount: text(flow.negated())! });

    const dailyReturn = endOfDayReturn(previous, snapshot.total, flow);
    if (dailyReturn !== null) {
      if (previous!.gt(0) || snapshot.total!.gt(0)) funded = true;
    } else if (previous !== null && snapshot.total !== null && flow !== null) {
      issues.add({
        code: previous.isZero() ? "UNDEFINED_ZERO_CAPITAL_RETURN" : "NEGATIVE_RETURN_CAPITAL",
        message: previous.isZero()
          ? "Non-flow wealth changed on a zero-opening-capital day. End-of-day cash-flow timing cannot identify that day's return."
          : "End-of-day flow adjustment produced negative investable capital; daily returns are undefined.",
        date, severity: "warning",
      });
    }
    pathValid = pathValid && dailyReturn !== null;
    let drawdown: MaybeD = null;
    if (pathValid && dailyReturn !== null) {
      index = index.times(ONE.plus(dailyReturn));
      peak = Decimal.max(peak, index);
      drawdown = index.div(peak).minus(1);
      maxDrawdown = Decimal.min(maxDrawdown, drawdown);
    }
    const dividends = ledger.dailyDividends.has(date) ? ledger.dailyDividends.get(date)! : ZERO;
    const comparativeFlow = add(flow, dividends);
    const priceDailyReturn = endOfDayReturn(previous, snapshot.total, comparativeFlow);
    pricePathValid = pricePathValid && priceDailyReturn !== null;
    if (priceDailyReturn !== null && (previous!.gt(0) || snapshot.total!.gt(0))) priceFunded = true;
    if (pricePathValid && priceDailyReturn !== null) priceIndex = priceIndex.times(ONE.plus(priceDailyReturn));
    if (priceDailyReturn === null && comparativeFlow !== null && previous !== null &&
      snapshot.total !== null && dividends !== null && !dividends.isZero()) {
      issues.add({
        code: "UNDEFINED_PORTFOLIO_PRICE_RETURN",
        message: "Dividend-excluded end-of-day portfolio return has zero opening or negative adjusted capital.",
        date, severity: "warning",
      });
    }
    if (benchmarkId) {
      const quote = market.priceBase(benchmarkId, date, filters.currency);
      const dailySplit = market.splitFactor(benchmarkId, shiftDate(date, -1), date);
      if (benchmarkUnits !== null && !benchmarkUnits.isZero()) benchmarkUnits = mul(benchmarkUnits, dailySplit);
      if (flow === null) benchmarkUnits = null;
      else if (!flow.isZero() && benchmarkUnits !== null) {
        if (quote === null || !quote.gt(0)) {
          benchmarkUnits = null;
          issues.add({ code: "BENCHMARK_FLOW_PRICE_MISSING", message: "A nonzero external flow cannot be invested without a positive same-day or permitted carried benchmark price.", date, assetId: benchmarkId, severity: "error" });
        } else {
          const nextUnits: D = benchmarkUnits.plus(flow.div(quote));
          if (nextUnits.lt(0)) {
            benchmarkUnits = null;
            issues.add({ code: "BENCHMARK_NEGATIVE_CAPITAL", message: "The identical-flow withdrawal exceeds the virtual benchmark's capital; borrowing or invented units are not assumed.", date, assetId: benchmarkId, severity: "warning" });
          } else {
            benchmarkUnits = nextUnits;
          }
        }
      }
      benchmarkValue = benchmarkUnits?.isZero() ? ZERO : mul(benchmarkUnits, quote);
      const factor = market.splitFactor(benchmarkId, openingDate, date);
      benchmarkReturn = benchmarkStart !== null && benchmarkStart.gt(0) && quote !== null && factor !== null
        ? quote.times(factor).div(benchmarkStart).minus(1) : null;
    }
    history.push({
      date, value: text(snapshot.total), netContributions: text(ledger.netContributions),
      externalFlow: text(flow), profit: text(profit),
      twr: text(pathValid && funded ? index.minus(1) : null),
      portfolioPriceTwr: text(pricePathValid && priceFunded ? priceIndex.minus(1) : null),
      dailyReturn: text(dailyReturn), drawdown: text(pathValid && funded ? drawdown : null),
      benchmarkValue: text(benchmarkValue), benchmarkReturn: text(benchmarkReturn),
    });
    previous = snapshot.total;
  }

  const total = finalSnapshot.total;
  if (total === null) missingCashflow = true;
  else investorFlows.push({ date: filters.to, amount: text(total)! });
  const mwr = missingCashflow
    ? unavailableXirr("MISSING_DATA", "Opening/terminal NAV or an external flow is unavailable.", count)
    : calculateXirr(investorFlows);
  if (mwr.status === "MULTIPLE_ROOTS" || mwr.status === "NON_CONVERGENT") {
    issues.add({ code: `MWR_${mwr.status}`, message: mwr.message, date: filters.to, severity: "warning" });
  }
  const totalPnl = sub(sub(total, opening), ledger.periodContributions);
  const simpleCapital = add(opening, ledger.positivePeriodContributions);
  const twr = pathValid && funded ? index.minus(1) : null;
  const benchmark: BenchmarkResult | null = benchmarkId ? {
    assetId: benchmarkId, returnType: "PRICE", from: openingDate, to: filters.to,
    returnRate: text(benchmarkReturn), cashflowValue: text(benchmarkValue),
    portfolioPriceReturn: text(pricePathValid && priceFunded ? priceIndex.minus(1) : null),
    pnl: text(sub(sub(benchmarkValue, opening), ledger.periodContributions)),
  } : null;
  const trades = ledger.trades(filters.to);
  return {
    filters: { ...filters, accountIds: [...filters.accountIds] },
    summary: {
      totalValue: text(total), costBasis: text(finalSnapshot.costBasis),
      realizedPnl: text(ledger.metrics.realized), unrealizedPnl: text(finalSnapshot.unrealizedPnl),
      totalPnl: text(totalPnl), netContributions: text(ledger.netContributions),
      dividends: text(ledger.metrics.dividends), grossDividends: text(ledger.metrics.grossDividends),
      interest: text(ledger.metrics.interest), fees: text(ledger.metrics.fees), taxes: text(ledger.metrics.taxes),
      simpleReturn: simpleCapital !== null && simpleCapital.gt(0) && totalPnl !== null
        ? text(totalPnl.div(simpleCapital)) : null,
      simpleReturnCapital: text(simpleCapital),
      twr: text(twr), twrAnnualized: text(annualize(twr, count)), mwr,
      mdd: text(pathValid && funded ? maxDrawdown : null),
      openingValue: text(opening), periodNetContributions: text(ledger.periodContributions),
      cumulativePnl: text(sub(total, ledger.netContributions)),
    },
    history, positions: finalSnapshot.positions, cash: finalSnapshot.cash, trades,
    issues: issues.values, benchmark, provenance: market.provenance, openingDate,
    calculationPolicy: "END_OF_DAY_V1",
  };
}
