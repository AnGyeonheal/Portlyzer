import type { AssetInput, Currency, FxInput, PriceInput } from "../domain";

export type ProviderId = "FRANKFURTER" | "ALPHA_VANTAGE" | "MANUAL" | "DEMO";

export interface ProviderCapabilities {
  prices: boolean;
  fx: boolean;
  dividends: boolean;
  corporateActions: boolean;
}

export interface ProviderContext {
  userId: string;
  isDemo: boolean;
}

export interface DateRange {
  from: string;
  to: string;
}

export interface ProviderAsset extends AssetInput {
  provider: string;
}

export interface PriceRequest extends DateRange {
  asset: ProviderAsset;
}

export interface FxRequest extends DateRange {
  base: Currency;
  quote: Currency;
}

export interface DividendObservation {
  assetId: string;
  exDate: string | null;
  recordDate: string | null;
  payDate: string | null;
  amountPerShare: string;
  currency: Currency;
  source: string;
  fetchedAt: string;
}

export interface CorporateActionObservation {
  assetId: string;
  date: string;
  kind: "SPLIT";
  ratio: string;
  source: string;
  fetchedAt: string;
}

export interface MarketDataProvider {
  readonly id: ProviderId;
  readonly capabilities: Readonly<ProviderCapabilities>;
  getPrices(request: PriceRequest, context: ProviderContext): Promise<PriceInput[]>;
  getFx(request: FxRequest, context: ProviderContext): Promise<FxInput[]>;
  getDividends(request: PriceRequest, context: ProviderContext): Promise<DividendObservation[]>;
  getCorporateActions(request: PriceRequest, context: ProviderContext): Promise<CorporateActionObservation[]>;
}
