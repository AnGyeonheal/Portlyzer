import type { AnalysisFilters, Currency } from "../domain";
import { Decimal, ZERO, add, daysBetween, mul, sub, sum, text, type D, type MaybeD } from "./decimal";
import type { Market } from "./market";
import type { CashResult, PositionResult, TradeResult } from "./types";
import type { ParsedTransaction } from "./validation";

interface Lot {
  id: string;
  acquisitionId: string;
  accountId: string;
  assetId: string;
  openedOn: string;
  openedSequence: number;
  closedOn: string | null;
  closedReason: "SOLD" | "TRANSFERRED" | null;
  quantity: D;
  remaining: D;
  sold: D;
  transferred: D;
  cost: D;
  costBase: MaybeD;
  investedBase: MaybeD;
  realized: D;
  realizedBase: MaybeD;
  periodRealizedBase: MaybeD;
  dividendsBase: MaybeD;
  disposals: { date: string; costBase: MaybeD }[];
  memo: string;
  tags: string[];
}

interface CashBalance {
  accountId: string;
  currency: Currency;
  balance: D;
}

export interface Snapshot {
  total: MaybeD;
  costBasis: MaybeD;
  unrealizedPnl: MaybeD;
  positions: PositionResult[];
  cash: CashResult[];
}

interface PeriodMetrics {
  realized: MaybeD;
  dividends: MaybeD;
  grossDividends: MaybeD;
  interest: MaybeD;
  fees: MaybeD;
  taxes: MaybeD;
}

const positionKey = (account: string, asset: string) => JSON.stringify([account, asset]);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export class Ledger {
  readonly lots: Lot[] = [];
  readonly balances = new Map<string, CashBalance>();
  readonly dailyFlows = new Map<string, MaybeD>();
  readonly dailyDividends = new Map<string, MaybeD>();
  readonly metrics: PeriodMetrics = {
    realized: ZERO, dividends: ZERO, grossDividends: ZERO,
    interest: ZERO, fees: ZERO, taxes: ZERO,
  };
  netContributions: MaybeD = ZERO;
  periodContributions: MaybeD = ZERO;
  positivePeriodContributions: MaybeD = ZERO;
  private readonly realizedByPosition = new Map<string, MaybeD>();
  private readonly dividendsByPosition = new Map<string, MaybeD>();
  private readonly quantities = new Map<string, D>();
  private readonly accounts: Set<string>;

  constructor(readonly market: Market, readonly filters: AnalysisFilters) {
    this.accounts = new Set(filters.accountIds);
  }

  selected(accountId: string): boolean {
    return this.accounts.size === 0 || this.accounts.has(accountId);
  }

  private convert(value: MaybeD, tx: ParsedTransaction): MaybeD {
    return this.market.convert(value, tx.raw.currency, this.filters.currency, tx.raw.date);
  }

  private cash(value: D, accountId: string, currency: Currency): void {
    const key = positionKey(accountId, currency);
    const existing = this.balances.get(key) ?? { accountId, currency, balance: ZERO };
    this.balances.set(key, { ...existing, balance: existing.balance.plus(value) });
  }

  private units(value: D, accountId: string, assetId: string): void {
    const key = positionKey(accountId, assetId);
    this.quantities.set(key, (this.quantities.get(key) ?? ZERO).plus(value));
  }

  private flow(value: MaybeD, date: string, incoming: boolean): void {
    this.netContributions = add(this.netContributions, value);
    this.dailyFlows.set(date, add(this.dailyFlows.has(date) ? this.dailyFlows.get(date)! : ZERO, value));
    if (date >= this.filters.from) {
      this.periodContributions = add(this.periodContributions, value);
      if (incoming) this.positivePeriodContributions = add(this.positivePeriodContributions, value);
    }
  }

  private eligible(accountId: string, assetId: string): Lot[] {
    return this.lots.filter(lot =>
      lot.accountId === accountId && lot.assetId === assetId && lot.remaining.gt(0))
      .sort((a, b) => compare(a.openedOn, b.openedOn) ||
        a.openedSequence - b.openedSequence ||
        compare(a.acquisitionId, b.acquisitionId) || compare(a.id, b.id));
  }

  private allocate(accountId: string, assetId: string, quantity: D): { lot: Lot; quantity: D }[] {
    const lots = this.eligible(accountId, assetId);
    let left = quantity;
    const result: { lot: Lot; quantity: D }[] = [];
    const total = lots.reduce((value, lot) => value.plus(lot.remaining), ZERO);
    // Reconcile complete disposal against the exact transaction quantity book,
    // not the sum of rounded proportional cohort quantities.
    if (quantity.eq(this.quantities.get(positionKey(accountId, assetId)) ?? total)) {
      return lots.map(lot => ({ lot, quantity: lot.remaining }));
    }
    for (let index = 0; index < lots.length && left.gt(0); index++) {
      const lot = lots[index];
      const allocated = this.filters.costMethod === "FIFO"
        ? Decimal.min(lot.remaining, left)
        : index === lots.length - 1 ? left : quantity.times(lot.remaining).div(total);
      if (allocated.gt(0)) result.push({ lot, quantity: allocated });
      left = left.minus(allocated);
    }
    return result;
  }

  private remove(lot: Lot, quantity: D): { cost: D; costBase: MaybeD } {
    const full = quantity.eq(lot.remaining);
    const fraction = full ? new Decimal(1) : quantity.div(lot.remaining);
    const cost = full ? lot.cost : lot.cost.times(fraction);
    const costBase = full ? lot.costBase : mul(lot.costBase, fraction);
    lot.remaining = lot.remaining.minus(quantity);
    lot.cost = full ? ZERO : lot.cost.minus(cost);
    lot.costBase = full ? ZERO : sub(lot.costBase, costBase);
    return { cost, costBase };
  }

  apply(tx: ParsedTransaction): void {
    const { raw, fee, tax, quantity, price, amount, toAmount, ratio } = tx;
    const selected = this.selected(raw.accountId);
    const inPeriod = raw.date >= this.filters.from;
    const charge = fee.plus(tax);
    if (selected && inPeriod) {
      this.metrics.fees = add(this.metrics.fees, this.convert(fee.plus(raw.kind === "FEE" ? amount! : ZERO), tx));
      this.metrics.taxes = add(this.metrics.taxes, this.convert(tax.plus(raw.kind === "TAX" ? amount! : ZERO), tx));
    }
    switch (raw.kind) {
      case "DEPOSIT":
        this.cash(amount!.minus(charge), raw.accountId, raw.currency);
        if (selected) this.flow(this.convert(amount, tx), raw.date, true);
        break;
      case "WITHDRAWAL":
        this.cash(amount!.plus(charge).negated(), raw.accountId, raw.currency);
        if (selected) this.flow(this.convert(amount!.negated(), tx), raw.date, false);
        break;
      case "BUY": {
        const cost = quantity!.times(price!).plus(charge);
        const costBase = this.convert(cost, tx);
        this.cash(cost.negated(), raw.accountId, raw.currency);
        this.lots.push({
          id: raw.id, acquisitionId: raw.id, accountId: raw.accountId, assetId: raw.assetId!,
          openedOn: raw.date, openedSequence: raw.sequence, closedOn: null, closedReason: null,
          quantity: quantity!, remaining: quantity!, sold: ZERO, transferred: ZERO,
          cost, costBase, investedBase: costBase,
          realized: ZERO, realizedBase: ZERO, periodRealizedBase: ZERO,
          dividendsBase: ZERO, disposals: [], memo: raw.memo, tags: [...raw.tags],
        });
        this.units(quantity!, raw.accountId, raw.assetId!);
        break;
      }
      case "SELL": {
        const proceeds = quantity!.times(price!).minus(charge);
        const proceedsBase = this.convert(proceeds, tx);
        this.cash(proceeds, raw.accountId, raw.currency);
        const allocations = this.allocate(raw.accountId, raw.assetId!, quantity!);
        let nativeLeft = proceeds;
        let baseLeft = proceedsBase;
        for (let i = 0; i < allocations.length; i++) {
          const { lot, quantity: removed } = allocations[i];
          const costs = this.remove(lot, removed);
          const last = i === allocations.length - 1;
          const native = last ? nativeLeft : proceeds.times(removed).div(quantity!);
          const base = last ? baseLeft : mul(proceedsBase, removed.div(quantity!));
          nativeLeft = nativeLeft.minus(native);
          baseLeft = sub(baseLeft, base);
          const realized = native.minus(costs.cost);
          const realizedBase = sub(base, costs.costBase);
          lot.sold = lot.sold.plus(removed);
          lot.realized = lot.realized.plus(realized);
          lot.realizedBase = add(lot.realizedBase, realizedBase);
          lot.disposals.push({ date: raw.date, costBase: costs.costBase });
          if (inPeriod) {
            lot.periodRealizedBase = add(lot.periodRealizedBase, realizedBase);
            const key = positionKey(raw.accountId, raw.assetId!);
            this.realizedByPosition.set(key, add(this.realizedByPosition.has(key) ? this.realizedByPosition.get(key)! : ZERO, realizedBase));
            if (selected) this.metrics.realized = add(this.metrics.realized, realizedBase);
          }
          if (lot.remaining.isZero()) {
            lot.closedOn = raw.date;
            lot.closedReason = "SOLD";
          }
        }
        this.units(quantity!.negated(), raw.accountId, raw.assetId!);
        break;
      }
      case "DIVIDEND":
      case "INTEREST": {
        const net = amount!.minus(charge);
        const netBase = this.convert(net, tx);
        this.cash(net, raw.accountId, raw.currency);
        if (raw.kind === "DIVIDEND") {
          const lots = this.eligible(raw.accountId, raw.assetId!);
          const total = lots.reduce((value, lot) => value.plus(lot.remaining), ZERO);
          let left = netBase;
          for (let i = 0; i < lots.length; i++) {
            const share = i === lots.length - 1 ? left : mul(netBase, lots[i].remaining.div(total));
            lots[i].dividendsBase = add(lots[i].dividendsBase, share);
            left = sub(left, share);
          }
          if (inPeriod) {
            const key = positionKey(raw.accountId, raw.assetId!);
            this.dividendsByPosition.set(key, add(this.dividendsByPosition.has(key) ? this.dividendsByPosition.get(key)! : ZERO, netBase));
            if (selected) {
              this.metrics.dividends = add(this.metrics.dividends, netBase);
              this.metrics.grossDividends = add(this.metrics.grossDividends, this.convert(amount, tx));
              this.dailyDividends.set(raw.date, add(
                this.dailyDividends.has(raw.date) ? this.dailyDividends.get(raw.date)! : ZERO, netBase));
            }
          }
        } else if (selected && inPeriod) {
          this.metrics.interest = add(this.metrics.interest, netBase);
        }
        break;
      }
      case "FEE":
      case "TAX":
        this.cash(amount!.plus(charge).negated(), raw.accountId, raw.currency);
        break;
      case "FX":
        this.cash(amount!.plus(charge).negated(), raw.accountId, raw.currency);
        this.cash(toAmount!, raw.accountId, raw.toCurrency!);
        break;
      case "TRANSFER": {
        const destinationSelected = this.selected(raw.toAccountId!);
        if (selected !== destinationSelected) {
          const native = raw.assetId ? mul(quantity, this.market.price(raw.assetId, raw.date)) : amount;
          const base = this.convert(native, tx);
          this.flow(selected && base !== null ? base.negated() : base, raw.date, destinationSelected);
        }
        this.cash(charge.negated(), raw.accountId, raw.currency);
        if (raw.assetId) {
          const allocations = this.allocate(raw.accountId, raw.assetId, quantity!);
          for (let i = 0; i < allocations.length; i++) {
            const { lot, quantity: moved } = allocations[i];
            const costs = this.remove(lot, moved);
            lot.transferred = lot.transferred.plus(moved);
            lot.investedBase = sub(lot.investedBase, costs.costBase);
            if (lot.remaining.isZero()) {
              lot.closedOn = raw.date;
              lot.closedReason = "TRANSFERRED";
            }
            this.lots.push({
              id: `${lot.acquisitionId}:transfer:${raw.id}:${i}`,
              acquisitionId: lot.acquisitionId, accountId: raw.toAccountId!, assetId: lot.assetId,
              openedOn: lot.openedOn, openedSequence: lot.openedSequence, closedOn: null, closedReason: null,
              quantity: moved, remaining: moved, sold: ZERO, transferred: ZERO,
              cost: costs.cost, costBase: costs.costBase, investedBase: costs.costBase,
              realized: ZERO, realizedBase: ZERO, periodRealizedBase: ZERO, dividendsBase: ZERO,
              disposals: [], memo: lot.memo, tags: [...lot.tags],
            });
          }
          this.units(quantity!.negated(), raw.accountId, raw.assetId);
          this.units(quantity!, raw.toAccountId!, raw.assetId);
        } else {
          this.cash(amount!.negated(), raw.accountId, raw.currency);
          this.cash(amount!, raw.toAccountId!, raw.currency);
        }
        break;
      }
      case "SPLIT": {
        for (const lot of this.eligible(raw.accountId, raw.assetId!)) {
          lot.quantity = lot.quantity.times(ratio!);
          lot.remaining = lot.remaining.times(ratio!);
          lot.sold = lot.sold.times(ratio!);
          lot.transferred = lot.transferred.times(ratio!);
        }
        const key = positionKey(raw.accountId, raw.assetId!);
        this.quantities.set(key, (this.quantities.get(key) ?? ZERO).times(ratio!));
        break;
      }
      case "VALUATION":
        break;
    }
  }

  snapshot(date: string): Snapshot {
    const groups = new Map<string, { accountId: string; assetId: string; lots: Lot[] }>();
    for (const lot of this.lots) {
      if (!this.selected(lot.accountId)) continue;
      const key = positionKey(lot.accountId, lot.assetId);
      const group = groups.get(key) ?? { accountId: lot.accountId, assetId: lot.assetId, lots: [] };
      group.lots.push(lot);
      groups.set(key, group);
    }
    for (const key of this.dividendsByPosition.keys()) {
      const [accountId, assetId] = JSON.parse(key) as [string, string];
      if (this.selected(accountId) && !groups.has(key)) groups.set(key, { accountId, assetId, lots: [] });
    }
    let total: MaybeD = ZERO;
    let costBasis: MaybeD = ZERO;
    let unrealizedPnl: MaybeD = ZERO;
    const positions: PositionResult[] = [];
    for (const [key, group] of groups) {
      const live = group.lots.filter(lot => lot.remaining.gt(0));
      const quantity = this.quantities.get(key) ?? ZERO;
      const realized = this.realizedByPosition.has(key) ? this.realizedByPosition.get(key)! : ZERO;
      const dividends = this.dividendsByPosition.has(key) ? this.dividendsByPosition.get(key)! : ZERO;
      if (quantity.isZero() && realized?.isZero() && dividends?.isZero()) continue;
      const nativeCost = live.reduce((value, lot) => value.plus(lot.cost), ZERO);
      const baseCost = sum(live.map(lot => lot.costBase));
      const native = quantity.isZero() ? ZERO : mul(quantity, this.market.price(group.assetId, date));
      const asset = this.market.assets.get(group.assetId)!;
      const base = this.market.convert(native, asset.currency, this.filters.currency, date);
      const unrealizedBase = sub(base, baseCost);
      total = add(total, base);
      costBasis = add(costBasis, baseCost);
      unrealizedPnl = add(unrealizedPnl, unrealizedBase);
      positions.push({
        accountId: group.accountId, assetId: group.assetId, quantity: text(quantity)!,
        averageCost: quantity.gt(0) ? text(nativeCost.div(quantity)) : null,
        costBasis: text(nativeCost), costBasisBase: text(baseCost),
        value: text(native), valueBase: text(base),
        unrealizedPnl: text(sub(native, nativeCost)), unrealizedPnlBase: text(unrealizedBase),
        realizedPnlBase: text(realized), dividendsBase: text(dividends), weight: null,
      });
    }
    const cash: CashResult[] = [];
    for (const balance of this.balances.values()) {
      if (!this.selected(balance.accountId)) continue;
      const base = this.market.convert(balance.balance, balance.currency, this.filters.currency, date);
      total = add(total, base);
      cash.push({ ...balance, balance: text(balance.balance)!, valueBase: text(base) });
    }
    for (const position of positions) {
      position.weight = total !== null && total.gt(0) && position.valueBase !== null
        ? text(new Decimal(position.valueBase).div(total)) : null;
    }
    positions.sort((a, b) => compare(a.accountId, b.accountId) || compare(a.assetId, b.assetId));
    cash.sort((a, b) => compare(a.accountId, b.accountId) || compare(a.currency, b.currency));
    return { total, costBasis, unrealizedPnl, positions, cash };
  }

  trades(date: string): TradeResult[] {
    return this.lots.filter(lot => this.selected(lot.accountId) &&
      (lot.closedOn === null || lot.closedOn >= this.filters.from)).map<TradeResult>(lot => {
      const value = lot.remaining.isZero() ? ZERO :
        mul(lot.remaining, this.market.priceBase(lot.assetId, date, this.filters.currency));
      const unrealized = sub(value, lot.costBase);
      const capitalContribution = add(lot.realizedBase, unrealized);
      const contribution = add(capitalContribution, lot.dividendsBase);
      let benchmarkReturn: MaybeD = null;
      if (this.filters.benchmarkAssetId && lot.investedBase !== null && lot.investedBase.gt(0)) {
        let benchmarkProfit: MaybeD = ZERO;
        for (const disposal of lot.disposals) {
          benchmarkProfit = add(benchmarkProfit, mul(disposal.costBase, this.market.priceReturn(
            this.filters.benchmarkAssetId, lot.openedOn, disposal.date, this.filters.currency)));
        }
        if (lot.remaining.gt(0)) {
          benchmarkProfit = add(benchmarkProfit, mul(lot.costBase, this.market.priceReturn(
            this.filters.benchmarkAssetId, lot.openedOn, date, this.filters.currency)));
        }
        benchmarkReturn = benchmarkProfit === null ? null : benchmarkProfit.div(lot.investedBase);
      }
      return {
        id: lot.id, acquisitionId: lot.acquisitionId, accountId: lot.accountId, assetId: lot.assetId,
        openedOn: lot.openedOn, closedOn: lot.closedOn,
        quantity: text(lot.quantity)!, remainingQuantity: text(lot.remaining)!,
        soldQuantity: text(lot.sold)!, transferredQuantity: text(lot.transferred)!,
        status: lot.remaining.isZero() ? "CLOSED" : lot.sold.gt(0) || lot.transferred.gt(0) ? "PARTIAL" : "OPEN",
        closedReason: lot.closedReason,
        costBasisBase: text(lot.costBase),
        realizedPnlBase: text(lot.realizedBase), periodRealizedPnlBase: text(lot.periodRealizedBase),
        unrealizedPnlBase: text(unrealized), dividendsBase: text(lot.dividendsBase),
        contributionBase: text(contribution),
        holdingDays: daysBetween(lot.openedOn, lot.closedOn ?? date),
        benchmarkReturn: text(benchmarkReturn),
        returnRate: contribution !== null && lot.investedBase !== null && lot.investedBase.gt(0)
          ? text(contribution.div(lot.investedBase)) : null,
        priceReturnRate: capitalContribution !== null && lot.investedBase !== null && lot.investedBase.gt(0)
          ? text(capitalContribution.div(lot.investedBase)) : null,
        memo: lot.memo, tags: [...lot.tags],
      };
    }).sort((a, b) => compare(a.openedOn, b.openedOn) || compare(a.id, b.id));
  }
}
