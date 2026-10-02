import { z } from "zod";
import type { PriceInput } from "../domain";
import { BaseProvider } from "./base";
import { invalidResponse, noObservations, ProviderError } from "./errors";
import { ProviderHttpClient, type HttpOptions } from "./http";
import type { PriceRequest, ProviderAsset, ProviderContext } from "./types";
import { dateRangeSchema, decimalStringSchema, observationDateSchema } from "./validation";

export interface AlphaVantageOptions extends HttpOptions {
  apiKey?: string;
  licenseAcknowledged?: boolean;
}

const dailySchema = z.object({
  "Meta Data": z.object({ "2. Symbol": z.string().min(1).max(32) }),
  "Time Series (Daily)": z.record(observationDateSchema, z.object({
    "4. close": decimalStringSchema,
  })),
});

function inspectEnvelope(body: unknown): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalidResponse();
  const row = body as Record<string, unknown>;
  const notice = row.Note ?? row.Information;
  if (typeof notice === "string") {
    if (/rate|frequency|call.+(?:day|minute)|limit|25 requests/i.test(notice)) {
      throw new ProviderError("PROVIDER_RATE_LIMITED", "Alpha Vantage reported a shared API-key rate limit.", true, 429);
    }
    throw new ProviderError("PROVIDER_REQUEST_REJECTED", "Alpha Vantage did not provide the requested free daily series.", false, 422);
  }
  if ("Error Message" in row) {
    throw new ProviderError("PROVIDER_REQUEST_REJECTED", "Alpha Vantage rejected the symbol or request.", false, 422);
  }
}

export function assertAlphaVantageAsset(asset: ProviderAsset): void {
  if (
    asset.provider !== "ALPHA_VANTAGE" || asset.currency !== "USD" || asset.country !== "US" ||
    !["STOCK", "ETF"].includes(asset.assetClass) ||
    !["NASDAQ", "NYSE", "AMEX"].includes(asset.exchange) ||
    !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(asset.symbol)
  ) {
    throw new ProviderError(
      "PROVIDER_UNSUPPORTED_ASSET",
      "Alpha Vantage requires an explicitly configured USD US STOCK/ETF on NASDAQ, NYSE or AMEX. Use manual data for other assets.",
      false,
      422,
    );
  }
}

export class AlphaVantageProvider extends BaseProvider {
  readonly id = "ALPHA_VANTAGE" as const;
  readonly capabilities = { prices: true, fx: false, dividends: false, corporateActions: false };
  private readonly http: ProviderHttpClient;
  private readonly apiKey: string;

  constructor(private readonly options: AlphaVantageOptions = {}) {
    super();
    this.apiKey = (options.apiKey ?? process.env.ALPHA_VANTAGE_API_KEY ?? "").trim();
    if (!this.apiKey) {
      throw new ProviderError("PROVIDER_NOT_CONFIGURED", "Set ALPHA_VANTAGE_API_KEY to opt in to Alpha Vantage.", false, 503);
    }
    if (!(options.licenseAcknowledged ?? process.env.ALPHA_VANTAGE_LICENSE_ACK === "true")) {
      throw new ProviderError(
        "PROVIDER_LICENSE_REQUIRED",
        "Review the Alpha Vantage terms and set ALPHA_VANTAGE_LICENSE_ACK=true only for an authorized deployment.",
        false,
        503,
      );
    }
    this.http = new ProviderHttpClient(options);
  }

  async getPrices(request: PriceRequest, _context: ProviderContext): Promise<PriceInput[]> {
    void _context;
    assertAlphaVantageAsset(request.asset);
    const { from, to } = dateRangeSchema.parse({ from: request.from, to: request.to });
    const url = new URL("https://www.alphavantage.co/query");
    url.search = new URLSearchParams({
      function: "TIME_SERIES_DAILY",
      symbol: request.asset.symbol,
      outputsize: "compact",
      datatype: "json",
      apikey: this.apiKey,
    }).toString();
    const response = await this.http.get(url, dailySchema, inspectEnvelope);
    if (response["Meta Data"]["2. Symbol"].toUpperCase() !== request.asset.symbol) throw invalidResponse();
    const dates = Object.keys(response["Time Series (Daily)"]).sort();
    if (dates.length === 0) throw noObservations();
    if (dates.length > 100) throw invalidResponse();
    if (from < dates[0]) {
      throw new ProviderError(
        "PROVIDER_HISTORY_UNAVAILABLE",
        "The free compact series contains at most the latest 100 observations and does not cover the requested start date. Import older raw closes manually.",
        false,
        422,
      );
    }
    const fetchedAt = (this.options.now?.() ?? new Date()).toISOString();
    const rows: PriceInput[] = dates.filter(date => date >= from && date <= to).map(date => ({
      assetId: request.asset.id,
      date,
      close: response["Time Series (Daily)"][date]["4. close"],
      currency: "USD",
      adjustment: "RAW",
      source: this.id,
      fetchedAt,
    }));
    if (rows.length === 0) throw noObservations();
    return rows;
  }
}
