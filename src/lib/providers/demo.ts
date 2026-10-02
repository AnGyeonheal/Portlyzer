import Decimal from "decimal.js";
import type { FxInput, PriceInput } from "../domain";
import { BaseProvider } from "./base";
import { noObservations, ProviderError } from "./errors";
import type { FxRequest, PriceRequest, ProviderContext } from "./types";
import { currencySchema, dateRangeSchema } from "./validation";

function assertDemo(context: ProviderContext): void {
  if (!context.isDemo) {
    throw new ProviderError("PROVIDER_DEMO_FORBIDDEN", "Synthetic observations are restricted to explicitly marked demo users.", false, 403);
  }
}

function businessDates(from: string, to: string): string[] {
  const range = dateRangeSchema.parse({ from, to });
  const dates: string[] = [];
  for (let timestamp = Date.parse(range.from); timestamp <= Date.parse(range.to); timestamp += 86_400_000) {
    const date = new Date(timestamp);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10));
  }
  if (!dates.length) throw noObservations();
  return dates;
}

export class DemoProvider extends BaseProvider {
  readonly id = "DEMO" as const;
  readonly capabilities = { prices: true, fx: true, dividends: false, corporateActions: false };

  async getPrices(request: PriceRequest, context: ProviderContext): Promise<PriceInput[]> {
    assertDemo(context);
    const fetchedAt = new Date().toISOString();
    const currency = currencySchema.parse(request.asset.currency);
    return businessDates(request.from, request.to).map(date => ({
      assetId: request.asset.id,
      date,
      close: currency === "KRW" ? "10000" : "100",
      currency,
      source: this.id,
      fetchedAt,
      adjustment: "RAW",
    }));
  }

  async getFx(request: FxRequest, context: ProviderContext): Promise<FxInput[]> {
    assertDemo(context);
    const base = currencySchema.parse(request.base);
    const quote = currencySchema.parse(request.quote);
    if (base === quote) throw new ProviderError("PROVIDER_UNSUPPORTED_PAIR", "Choose two different currencies.", false, 422);
    const fetchedAt = new Date().toISOString();
    return businessDates(request.from, request.to).map(date => ({
      date, base, quote,
      rate: base === "USD" ? "1300" : new Decimal(1).div(1300).toFixed(12),
      source: this.id,
      fetchedAt,
    }));
  }
}
