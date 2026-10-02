import Decimal from "decimal.js";
import { z } from "zod";
import type { FxInput } from "../domain";
import { BaseProvider } from "./base";
import { invalidResponse, noObservations, ProviderError } from "./errors";
import { ProviderHttpClient, type HttpOptions } from "./http";
import type { FxRequest, ProviderContext } from "./types";
import { currencySchema, dateRangeSchema, observationDateSchema, positiveDecimalSchema } from "./validation";

const ratesSchema = z.array(z.object({
  date: observationDateSchema,
  base: currencySchema,
  quote: currencySchema,
  rate: z.number().finite().positive(),
})).max(366);

export class FrankfurterProvider extends BaseProvider {
  readonly id = "FRANKFURTER" as const;
  readonly capabilities = { prices: false, fx: true, dividends: false, corporateActions: false };
  private readonly http: ProviderHttpClient;

  constructor(private readonly options: HttpOptions = {}) {
    super();
    this.http = new ProviderHttpClient(options);
  }

  async getFx(request: FxRequest, _context: ProviderContext): Promise<FxInput[]> {
    void _context;
    const { from, to } = dateRangeSchema.parse({ from: request.from, to: request.to });
    const base = currencySchema.parse(request.base);
    const quote = currencySchema.parse(request.quote);
    if (base === quote) {
      throw new ProviderError("PROVIDER_UNSUPPORTED_PAIR", "Choose two different currencies.", false, 422);
    }
    if (from < "1999-01-04") {
      throw new ProviderError("PROVIDER_HISTORY_UNAVAILABLE", "ECB USD/KRW observations start on 1999-01-04.", false, 422);
    }
    const url = new URL("https://api.frankfurter.dev/v2/providers/ecb/rates");
    url.search = new URLSearchParams({ base, quotes: quote, from, to }).toString();
    const rows = await this.http.get(url, ratesSchema);
    if (rows.length === 0) throw noObservations();
    const seen = new Set<string>();
    const fetchedAt = (this.options.now?.() ?? new Date()).toISOString();
    return rows.map(row => {
      if (row.base !== base || row.quote !== quote || row.date < from || row.date > to || seen.has(row.date)) {
        throw invalidResponse();
      }
      seen.add(row.date);
      const rate = new Decimal(row.rate.toString()).toFixed();
      if (!positiveDecimalSchema.safeParse(rate).success) throw invalidResponse();
      return { date: row.date, base, quote, rate, source: this.id, fetchedAt };
    }).sort((a, b) => a.date.localeCompare(b.date));
  }
}
