import { AppError } from "../errors";
import type { ProviderCapabilities, ProviderId } from "./types";

export class ProviderError extends AppError {
  constructor(
    code: string,
    message: string,
    public readonly retryable = false,
    status = 502,
    public readonly retryAfterMs?: number,
  ) {
    super(status, code, message);
    this.name = "ProviderError";
  }
}

export function unsupported(provider: ProviderId, capability: keyof ProviderCapabilities): ProviderError {
  return new ProviderError(
    "PROVIDER_UNSUPPORTED",
    `${provider} does not supply ${capability}. Use a supported provider or enter verified data manually.`,
    false,
    422,
  );
}

export function invalidResponse(): ProviderError {
  return new ProviderError("PROVIDER_INVALID_RESPONSE", "The provider returned an invalid response. Existing observations were not changed.");
}

export function noObservations(): ProviderError {
  return new ProviderError("PROVIDER_NO_DATA", "No observations were returned for this range. Non-trading days are not fabricated.", false, 422);
}
