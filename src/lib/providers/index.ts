import { AlphaVantageProvider, type AlphaVantageOptions } from "./alpha-vantage";
import { DemoProvider } from "./demo";
import { ProviderError } from "./errors";
import { FrankfurterProvider } from "./frankfurter";
import { ManualProvider } from "./manual";
import type { MarketDataProvider, ProviderContext, ProviderId } from "./types";

export type * from "./types";
export { AlphaVantageProvider, DemoProvider, FrankfurterProvider, ManualProvider, ProviderError };

export function createMarketDataProvider(
  id: ProviderId,
  context: ProviderContext,
  options: AlphaVantageOptions = {},
): MarketDataProvider {
  switch (id) {
    case "FRANKFURTER": return new FrankfurterProvider(options);
    case "ALPHA_VANTAGE": return new AlphaVantageProvider(options);
    case "MANUAL": return new ManualProvider();
    case "DEMO":
      if (!context.isDemo) {
        throw new ProviderError("PROVIDER_DEMO_FORBIDDEN", "Demo data is not available to real users.", false, 403);
      }
      return new DemoProvider();
    default:
      throw new ProviderError("PROVIDER_UNSUPPORTED", "This market data provider is not supported.", false, 422);
  }
}
