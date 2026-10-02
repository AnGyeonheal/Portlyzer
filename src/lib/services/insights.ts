import Decimal from "decimal.js";
import type { DividendEvent, InvestmentGoal } from "@prisma/client";
import type { AssetInput, AnalysisFilters, FxInput } from "../domain";
import type { DividendAggregate, DividendData, GoalDto, TransactionDto } from "../contracts";
import { convertCurrency, historicalQuantities, projectGoal } from "../finance";
import { dayOf, shiftDay } from "../input";
import { AppError } from "../errors";

const Amount = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_EVEN });
function nullableSum(values: (string | null)[]): string | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<Decimal>((sum, value) => sum.plus(value ?? "0"), new Amount(0)).toString();
}

export function dividendInsights(
  events: DividendEvent[],
  transactions: TransactionDto[],
  assets: AssetInput[],
  fx: FxInput[],
  filters: AnalysisFilters,
): DividendData {
  const selected = new Set(filters.accountIds);
  const receipts = transactions.filter((tx) => tx.kind === "DIVIDEND" && selected.has(tx.accountId) && tx.date <= filters.to);
  const actual = receipts.filter((tx) => tx.date >= filters.from).map((tx) => ({
    transactionId: tx.id, assetId: tx.assetId ?? null, accountId: tx.accountId,
    date: tx.date, currency: tx.currency, gross: tx.amount ?? "0", tax: tx.tax,
    net: new Amount(tx.amount ?? "0").minus(tx.tax).minus(tx.fee).toString(),
    netBase: convertCurrency(new Amount(tx.amount ?? "0").minus(tx.tax).minus(tx.fee).toString(), tx.currency, filters.currency, tx.date, fx),
    eventId: tx.dividendEventId,
  }));
  const aggregate = (key: (row: (typeof actual)[number]) => string): DividendAggregate[] => {
    const groups = new Map<string, (typeof actual)>();
    for (const row of actual) {
      const id = key(row);
      groups.set(id, [...(groups.get(id) ?? []), row]);
    }
    return [...groups].map(([id, rows]) => ({
      key: id,
      gross: nullableSum(rows.map((row) => convertCurrency(row.gross, row.currency, filters.currency, row.date, fx))),
      tax: nullableSum(rows.map((row) => convertCurrency(row.tax, row.currency, filters.currency, row.date, fx))),
      net: nullableSum(rows.map((row) => row.netBase)),
    })).sort((a, b) => a.key.localeCompare(b.key));
  };
  const horizon = shiftDay(filters.to, 366);
  const upcoming = events
    .filter((event) => (!event.payDate || (dayOf(event.payDate) >= filters.from && dayOf(event.payDate) <= horizon)) && dayOf(event.asOf) <= filters.to)
    .map((event) => {
      const exDate = event.exDate ? dayOf(event.exDate) : null;
      const payDate = event.payDate ? dayOf(event.payDate) : null;
      const missing: string[] = [];
      if (!payDate) missing.push("지급일 미확인: 배당락일을 지급일로 대체하지 않습니다.");
      if (!exDate) missing.push("배당락일 미확인: 배당 자격과 예상액을 계산할 수 없습니다.");
      if (event.status === "ESTIMATED") missing.push("추정 배당이며 확정 수익이 아닙니다.");
      const eventReceipts = receipts.filter((tx) => tx.dividendEventId === event.id);
      const receivedAccounts = new Set(eventReceipts.map((tx) => tx.accountId));
      let eligibleQuantity: string | null = null;
      let expectedGross: string | null = null;
      if (exDate) {
        const cutoff = exDate > filters.to ? filters.to : shiftDay(exDate, -1);
        const quantities = historicalQuantities(transactions, assets, cutoff, filters.costMethod)
          .filter((position) => position.assetId === event.assetId && selected.has(position.accountId));
        if (exDate > filters.to) missing.push("미래 배당락일까지 보유량이 달라질 수 있습니다. 선택 종료일 보유량 기준입니다.");
        let eligible = new Amount(0);
        let unpaid = new Amount(0);
        for (const position of quantities) {
          let quantity = new Amount(position.quantity);
          if (exDate <= filters.to) {
            for (const split of transactions.filter((tx) => tx.date === exDate && tx.kind === "SPLIT" && tx.assetId === event.assetId && tx.accountId === position.accountId)) {
              quantity = quantity.mul(split.ratio ?? "1");
            }
          }
          eligible = eligible.plus(quantity);
          if (!receivedAccounts.has(position.accountId)) unpaid = unpaid.plus(quantity);
        }
        eligibleQuantity = eligible.toString();
        expectedGross = unpaid.mul(event.amountPerShare.toString()).toString();
        if (eligible.isZero()) missing.push("선택 계좌의 기준일 배당 자격 보유량이 없습니다.");
      }
      const expectedGrossBase = expectedGross === null ? null
        : convertCurrency(expectedGross, event.currency, filters.currency, filters.to, fx);
      if (expectedGross !== null && expectedGrossBase === null) missing.push("기준 통화 환율 누락: 예상 환산액을 표시할 수 없습니다.");
      if (payDate && payDate < filters.to && expectedGross !== null && new Amount(expectedGross).gt(0)) {
        missing.push("예정 지급일이 지났지만 연결된 실제 입금 거래가 없습니다.");
      }
      return {
        id: event.id, assetId: event.assetId, status: event.status, exDate, payDate,
        recordDate: event.recordDate ? dayOf(event.recordDate) : null,
        asOf: dayOf(event.asOf), currency: event.currency, amountPerShare: event.amountPerShare.toString(),
        eligibleQuantity, expectedGross, expectedGrossBase,
        receivedGross: eventReceipts.reduce((sum, tx) => sum.plus(tx.amount ?? "0"), new Amount(0)).toString(),
        reconciled: eventReceipts.length > 0 && expectedGross === "0",
        source: event.source, basis: event.basis, missing,
      };
    }).sort((a, b) => (a.payDate ?? "9999").localeCompare(b.payDate ?? "9999"));
  return {
    actual, upcoming,
    monthly: aggregate((row) => row.date.slice(0, 7)),
    yearly: aggregate((row) => row.date.slice(0, 4)),
    byAsset: aggregate((row) => row.assetId ?? "미분류"),
  };
}

export function goalInsights(
  goals: InvestmentGoal[], totalValue: string | null, dividends: DividendData,
  fx: FxInput[], filters: AnalysisFilters,
): GoalDto[] {
  const monthly = dividends.monthly.find((row) => row.key === filters.to.slice(0, 7));
  return goals.map((goal) => {
    if (goal.kind !== "ASSET" && goal.kind !== "DIVIDEND") throw new AppError(422, "GOAL_KIND", "저장된 목표 유형이 올바르지 않습니다.");
    const sourceValue = goal.kind === "ASSET" ? totalValue : monthly ? monthly.net : "0";
    const actualValue = sourceValue === null ? null : convertCurrency(sourceValue, filters.currency, goal.currency, filters.to, fx);
    const projection = projectGoal({
      initial: goal.initial.toString(), monthlyContribution: goal.monthlyContribution.toString(),
      annualReturn: goal.annualReturn.toString(), years: goal.years,
    });
    return {
      id: goal.id, name: goal.name, kind: goal.kind,
      currency: goal.currency, target: goal.target.toString(), initial: goal.initial.toString(),
      monthlyContribution: goal.monthlyContribution.toString(), annualReturn: goal.annualReturn.toString(), years: goal.years,
      actualValue, progress: actualValue === null ? null : new Amount(actualValue).div(goal.target.toString()).toString(),
      projection,
    };
  });
}
