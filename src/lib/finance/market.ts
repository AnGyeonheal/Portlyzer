import type { AssetInput, Currency, FxInput, PriceInput } from "../domain";
import { Issues, ONE, ZERO, daysBetween, decimal, mul, text, validDate, type D, type MaybeD } from "./decimal";
import type { MarketDataProvenance } from "./types";
import type { ParsedTransaction } from "./validation";
import { isCurrency } from "./validation";

export const MAX_CARRY_DAYS = 7;

interface Observation {
  date: string;
  value: D;
  source: string;
  fetchedAt: string | null;
  transactionId?: string;
  inverted?: boolean;
  divisor?: D;
}

function order(a: Observation, b: Observation): number {
  const timeA = a.fetchedAt === null ? 0 : Date.parse(a.fetchedAt);
  const timeB = b.fetchedAt === null ? 0 : Date.parse(b.fetchedAt);
  return a.date.localeCompare(b.date) ||
    (Number.isFinite(timeA) ? timeA : 0) - (Number.isFinite(timeB) ? timeB : 0) ||
    (a.fetchedAt ?? "").localeCompare(b.fetchedAt ?? "") ||
    a.source.localeCompare(b.source) || a.value.cmp(b.value) ||
    Number(!a.inverted) - Number(!b.inverted);
}

function latest(series: Observation[], date: string): Observation | undefined {
  let low = 0;
  let high = series.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (series[middle].date <= date) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? undefined : series[low - 1];
}

export class Market {
  readonly provenance: MarketDataProvenance[] = [];
  readonly assets: Map<string, AssetInput>;
  private readonly prices = new Map<string, Observation[]>();
  private readonly overrides = new Map<string, Observation[]>();
  private readonly rates = new Map<string, Observation[]>();
  private readonly cache = new Map<string, MaybeD>();
  private readonly splits = new Map<string, { date: string; ratio: MaybeD }[]>();

  constructor(
    assets: AssetInput[],
    prices: PriceInput[],
    fx: FxInput[],
    transactions: ParsedTransaction[],
    private readonly issues: Issues,
    through: string,
  ) {
    this.assets = new Map(assets.map(asset => [asset.id, asset]));
    for (const price of prices) {
      if (validDate(price.date) && price.date > through) continue;
      const asset = this.assets.get(price.assetId);
      const close = decimal(price.close);
      if (!asset || !validDate(price.date) || close === null || close.lt(0) ||
        price.currency !== asset.currency || price.adjustment !== "RAW") {
        issues.add({
          code: price.adjustment !== "RAW" ? "ADJUSTED_PRICE_REJECTED" : "INVALID_PRICE",
          message: "Prices require a known asset, matching currency, valid date, nonnegative close and RAW adjustment.",
          assetId: price.assetId, date: price.date, severity: "error",
        });
        continue;
      }
      const series = this.prices.get(price.assetId) ?? [];
      series.push({ date: price.date, value: close, source: price.source, fetchedAt: price.fetchedAt });
      this.prices.set(price.assetId, series);
    }
    for (const row of fx) {
      if (validDate(row.date) && row.date > through) continue;
      const rate = decimal(row.rate);
      if (!validDate(row.date) || !isCurrency(row.base) || !isCurrency(row.quote) ||
        row.base === row.quote || rate === null || !rate.gt(0)) {
        issues.add({ code: "INVALID_FX_RATE", message: "FX observations require different supported currencies, a valid date and a positive rate.", date: row.date, severity: "error" });
        continue;
      }
      for (const inverted of [false, true]) {
        const base = inverted ? row.quote : row.base;
        const quote = inverted ? row.base : row.quote;
        const key = `${base}:${quote}`;
        const series = this.rates.get(key) ?? [];
        series.push({
          date: row.date, value: inverted ? ONE.div(rate) : rate,
          source: row.source, fetchedAt: row.fetchedAt, inverted,
          ...(inverted ? { divisor: rate } : {}),
        });
        this.rates.set(key, series);
      }
    }
    for (const [assetId, series] of this.prices) this.sortSeries(series, "PRICE", assetId);
    for (const [pair, series] of this.rates) this.sortSeries(series, "FX", pair);
    const splitGroups = new Map<string, Map<string, D>>();
    for (const tx of transactions) {
      if (tx.raw.date > through) continue;
      if (tx.raw.kind === "VALUATION") {
        const series = this.overrides.get(tx.raw.assetId!) ?? [];
        series.push({
          date: tx.raw.date, value: tx.price!, source: "MANUAL_VALUATION",
          fetchedAt: null, transactionId: tx.raw.id,
        });
        this.overrides.set(tx.raw.assetId!, series);
      }
      if (tx.raw.kind === "SPLIT") {
        const key = JSON.stringify([tx.raw.assetId, tx.raw.date]);
        const accounts = splitGroups.get(key) ?? new Map<string, D>();
        accounts.set(tx.raw.accountId, (accounts.get(tx.raw.accountId) ?? ONE).times(tx.ratio!));
        splitGroups.set(key, accounts);
      }
    }
    for (const [key, accounts] of splitGroups) {
      const [assetId, date] = JSON.parse(key) as [string, string];
      const ratios = [...accounts.values()];
      const ratio = ratios.every(value => value.eq(ratios[0])) ? ratios[0] : null;
      if (ratio === null) issues.add({
        code: "AMBIGUOUS_BENCHMARK_SPLIT",
        message: "Account split records disagree; benchmark split adjustment cannot be inferred.",
        assetId, date, severity: "warning",
      });
      const series = this.splits.get(assetId) ?? [];
      series.push({ date, ratio });
      this.splits.set(assetId, series);
    }
    for (const series of this.splits.values()) series.sort((a, b) => a.date.localeCompare(b.date));
  }

  private sortSeries(series: Observation[], kind: string, identifier: string): void {
    series.sort(order);
    for (let i = 1; i < series.length; i++) {
      if (series[i - 1].date === series[i].date && !series[i - 1].value.eq(series[i].value)) {
        this.issues.add({
          code: "CONFLICTING_MARKET_DATA",
          message: `${kind} ${identifier} has conflicting observations; the latest fetchedAt, then source/value, wins deterministically.`,
          date: series[i].date, severity: "warning",
        });
      }
    }
  }

  private resolve(
    key: string,
    date: string,
    observation: Observation | undefined,
    metadata: Pick<MarketDataProvenance, "kind" | "assetId" | "base" | "quote">,
  ): MaybeD {
    if (this.cache.has(key)) return this.cache.get(key)!;
    const age = observation ? daysBetween(observation.date, date) : null;
    const stale = age !== null && age > MAX_CARRY_DAYS;
    const carried = age !== null && age > 0;
    const value = observation && !stale ? observation.value : null;
    this.cache.set(key, value);
    this.provenance.push({
      ...metadata,
      asOf: date,
      observedOn: observation?.date ?? null,
      value: text(observation?.value ?? null),
      source: observation?.source ?? null,
      fetchedAt: observation?.fetchedAt ?? null,
      ageDays: age,
      carried,
      stale,
      usable: value !== null,
      ...(metadata.kind === "PRICE" ? { adjustment: "RAW" as const } : { inverted: observation?.inverted ?? false }),
      ...(observation?.transactionId ? { transactionId: observation.transactionId } : {}),
    });
    const subject = metadata.kind === "PRICE" ? metadata.assetId : `${metadata.base}/${metadata.quote}`;
    if (!observation || stale) {
      this.issues.add({
        code: `${stale ? "STALE" : "MISSING"}_${metadata.kind}`,
        message: observation
          ? `${subject}: latest observation is ${age} calendar days old; carry limit is ${MAX_CARRY_DAYS}.`
          : `${subject}: no observation exists on or before this date.`,
        date, assetId: metadata.assetId, severity: "error",
      });
    } else if (carried) {
      this.issues.add({
        code: `CARRIED_${metadata.kind}`,
        message: `${subject}: carried ${age} calendar day(s) from ${observation.date}.`,
        date, assetId: metadata.assetId, severity: "warning",
      });
    }
    return value;
  }

  price(assetId: string, date: string): MaybeD {
    const observation = latest(this.overrides.get(assetId) ?? [], date) ??
      latest(this.prices.get(assetId) ?? [], date);
    return this.resolve(`P:${assetId}:${date}`, date, observation, { kind: "PRICE", assetId });
  }

  rate(base: Currency, quote: Currency, date: string): MaybeD {
    if (base === quote) return ONE;
    return this.resolve(`F:${base}:${quote}:${date}`, date,
      latest(this.rates.get(`${base}:${quote}`) ?? [], date), { kind: "FX", base, quote });
  }

  convert(amount: MaybeD, currency: Currency, target: Currency, date: string): MaybeD {
    if (amount === null) return null;
    if (amount.isZero()) return ZERO;
    if (currency === target) return amount;
    const rate = this.rate(currency, target, date);
    if (rate === null) return null;
    const observation = latest(this.rates.get(`${currency}:${target}`) ?? [], date);
    return observation?.divisor ? amount.div(observation.divisor) : amount.times(rate);
  }

  priceBase(assetId: string, date: string, currency: Currency): MaybeD {
    const asset = this.assets.get(assetId);
    return asset ? this.convert(this.price(assetId, date), asset.currency, currency, date) : null;
  }

  splitFactor(assetId: string, fromExclusive: string, toInclusive: string): MaybeD {
    let factor: MaybeD = ONE;
    for (const event of this.splits.get(assetId) ?? []) {
      if (event.date > fromExclusive && event.date <= toInclusive) factor = mul(factor, event.ratio);
    }
    return factor;
  }

  priceReturn(assetId: string, from: string, to: string, currency: Currency): MaybeD {
    const start = this.priceBase(assetId, from, currency);
    const end = this.priceBase(assetId, to, currency);
    const factor = this.splitFactor(assetId, from, to);
    if (start === null || end === null || factor === null || !start.gt(0)) return null;
    return end.times(factor).div(start).minus(1);
  }
}
