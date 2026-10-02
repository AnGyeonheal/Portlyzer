import type { FxInput, PriceInput } from "../domain";
import { unsupported } from "./errors";
import type {
  CorporateActionObservation, DividendObservation, FxRequest, MarketDataProvider,
  PriceRequest, ProviderCapabilities, ProviderContext, ProviderId,
} from "./types";

export abstract class BaseProvider implements MarketDataProvider {
  abstract readonly id: ProviderId;
  readonly capabilities: Readonly<ProviderCapabilities> = {
    prices: false, fx: false, dividends: false, corporateActions: false,
  };

  getPrices(_request: PriceRequest, _context: ProviderContext): Promise<PriceInput[]> {
    void _request;
    void _context;
    return Promise.reject(unsupported(this.id, "prices"));
  }

  getFx(_request: FxRequest, _context: ProviderContext): Promise<FxInput[]> {
    void _request;
    void _context;
    return Promise.reject(unsupported(this.id, "fx"));
  }

  getDividends(_request: PriceRequest, _context: ProviderContext): Promise<DividendObservation[]> {
    void _request;
    void _context;
    return Promise.reject(unsupported(this.id, "dividends"));
  }

  getCorporateActions(_request: PriceRequest, _context: ProviderContext): Promise<CorporateActionObservation[]> {
    void _request;
    void _context;
    return Promise.reject(unsupported(this.id, "corporateActions"));
  }
}
