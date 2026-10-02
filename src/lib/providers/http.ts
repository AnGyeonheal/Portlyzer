import type { ZodType } from "zod";
import { invalidResponse, ProviderError } from "./errors";

export interface HttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  beforeRequest?: () => Promise<void>;
}

const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 5000;
const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;

function retryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const numeric = Number(value);
  const milliseconds = /^\s*\d+(?:\.\d+)?\s*$/.test(value)
    ? numeric * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, Math.min(milliseconds, MAX_BACKOFF_MS)) : undefined;
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderError("PROVIDER_RESPONSE_TOO_LARGE", "The provider response exceeded the size limit.");
  }
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderError("PROVIDER_RESPONSE_TOO_LARGE", "The provider response exceeded the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalidResponse();
  }
}

export class ProviderHttpClient {
  private readonly options: HttpOptions;

  constructor(options: HttpOptions = {}) {
    this.options = options;
  }

  async get<T>(url: URL, schema: ZodType<T>, inspect?: (body: unknown) => void): Promise<T> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // Every physical request, including a retry, consumes the shared provider budget.
      await this.options.beforeRequest?.();
      try {
        return await this.attempt(url, schema, inspect);
      } catch (error) {
        const failure = error instanceof ProviderError ? error :
          new ProviderError("PROVIDER_UNAVAILABLE", "The provider could not be reached.", true);
        if (!failure.retryable || attempt === MAX_ATTEMPTS - 1) throw failure;
        const wait = Math.min(MAX_BACKOFF_MS, failure.retryAfterMs ?? 250 * 2 ** attempt);
        await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(wait);
      }
    }
    throw new ProviderError("PROVIDER_UNAVAILABLE", "The provider could not be reached.");
  }

  private async attempt<T>(url: URL, schema: ZodType<T>, inspect?: (body: unknown) => void): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderError("PROVIDER_TIMEOUT", "The provider request timed out.", true, 504));
      }, this.options.timeoutMs ?? 10_000);
    });
    const operation = async () => {
      const response = await (this.options.fetch ?? fetch)(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 429) {
          throw new ProviderError(
            "PROVIDER_RATE_LIMITED", "The provider rate limit was reached.", true, 429,
            retryAfter(response.headers.get("retry-after"), (this.options.now?.() ?? new Date()).getTime()),
          );
        }
        if (response.status >= 500) {
          throw new ProviderError(
            "PROVIDER_UNAVAILABLE", "The provider is temporarily unavailable.", true, 502,
            retryAfter(response.headers.get("retry-after"), (this.options.now?.() ?? new Date()).getTime()),
          );
        }
        if (response.status === 408) {
          throw new ProviderError("PROVIDER_TIMEOUT", "The provider request timed out.", true, 504);
        }
        throw new ProviderError("PROVIDER_HTTP_ERROR", "The provider rejected the request.");
      }
      const body = await readJson(response, this.options.maxBodyBytes ?? DEFAULT_BODY_LIMIT);
      inspect?.(body);
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw invalidResponse();
      return parsed.data;
    };
    try {
      return await Promise.race([operation(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
