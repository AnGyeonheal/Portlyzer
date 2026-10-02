import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AlphaVantageProvider, createMarketDataProvider, DemoProvider, FrankfurterProvider,
  ManualProvider, ProviderError, type ProviderAsset, type ProviderId,
} from "../../src/lib/providers";
import { ProviderHttpClient } from "../../src/lib/providers/http";
import {
  manualFxImportSchema, manualFxSchema, manualPriceImportSchema, manualPriceSchema, refreshSchema,
} from "../../src/lib/providers/validation";

const context = { userId: "user-1", isDemo: false };
const asset: ProviderAsset = {
  id: "asset-1", symbol: "IBM", name: "IBM", exchange: "NYSE", currency: "USD",
  assetClass: "STOCK", country: "US", sector: null, provider: "ALPHA_VANTAGE",
};
const range = { from: "2024-01-02", to: "2024-01-05" };
const fxRequest = { ...range, base: "USD" as const, quote: "KRW" as const };
const priceRequest = { ...range, asset };
const fxRows = [
  { date: "2024-01-02", base: "USD", quote: "KRW", rate: 1313.23 },
  { date: "2024-01-05", base: "USD", quote: "KRW", rate: 1314.57 },
];
const daily = {
  "Meta Data": { "2. Symbol": "IBM" },
  "Time Series (Daily)": {
    "2024-01-02": { "1. open": "160.0", "4. close": "161.5000", "5. volume": "100" },
    "2024-01-05": { "4. close": "163.0000" },
  },
};
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers },
});
const avOptions = { apiKey: "test-key-not-a-secret", licenseAcknowledged: true };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("manual observation validation", () => {
  const price = { assetId: "asset-1", date: "2024-01-02", close: "123.123456789012", currency: "USD" };

  it("accepts exact strings including zero-valued prices, and both FX directions", () => {
    expect(manualPriceSchema.parse(price).close).toBe("123.123456789012");
    expect(manualPriceSchema.parse({ ...price, close: "0" }).close).toBe("0");
    expect(manualFxSchema.parse({ date: price.date, base: "KRW", quote: "USD", rate: "0.00076" }).rate).toBe("0.00076");
  });

  it.each([123, "", "1e3", "NaN", "Infinity", "-1", "+1", ".5", "1.", "1,000", " 1", "01", "1234567890123456789", "0.1234567890123"])(
    "rejects noncanonical or out-of-storage-range decimals: %s",
    close => expect(manualPriceSchema.safeParse({ ...price, close }).success).toBe(false),
  );

  it.each(["2023-02-29", "2024-02-30", "2024-13-01", "2024-1-02", "2024-01-02T12:00:00Z", "0000-01-01", "9999-01-01"])(
    "rejects invalid/future observation dates: %s",
    date => expect(manualPriceSchema.safeParse({ ...price, date }).success).toBe(false),
  );

  it("rejects source/adjustment spoofing, invalid FX, duplicate imports and >2,000 rows", () => {
    expect(manualPriceSchema.safeParse({ ...price, source: "DEMO" }).success).toBe(false);
    expect(manualPriceSchema.safeParse({ ...price, adjustment: "ADJUSTED" }).success).toBe(false);
    for (const rate of ["0", "garbage", "NaN", "1e3", -1]) {
      expect(manualFxSchema.safeParse({ date: price.date, base: "USD", quote: "KRW", rate }).success).toBe(false);
    }
    expect(manualFxSchema.safeParse({ date: price.date, base: "USD", quote: "USD", rate: "1" }).success).toBe(false);
    expect(manualPriceImportSchema.safeParse({ rows: [price, price] }).success).toBe(false);
    expect(manualPriceImportSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(manualPriceImportSchema.safeParse({ rows: Array.from({ length: 2001 }, (_, i) => ({ ...price, assetId: `asset-${i}` })) }).success).toBe(false);
  });

  it("requires an explicit supported refresh shape and bounded date range", () => {
    expect(refreshSchema.parse({ provider: "FRANKFURTER", ...range }).provider).toBe("FRANKFURTER");
    for (const input of [
      { provider: "DEMO", ...range },
      { provider: "COINBASE", ...range },
      { provider: "ALPHA_VANTAGE", ...range },
      { provider: "FRANKFURTER", ...range, assetId: "asset-1" },
      { provider: "FRANKFURTER", from: range.to, to: range.from },
      { provider: "FRANKFURTER", from: "2020-01-01", to: "2024-01-01" },
    ]) expect(refreshSchema.safeParse(input).success).toBe(false);
  });

  it("validates complete FX imports, including opposite-pair duplicate keys", () => {
    const row = { date: "2024-01-02", base: "USD", quote: "KRW", rate: "1313.23" };
    expect(manualFxImportSchema.parse({ rows: [row] }).rows).toHaveLength(1);
    expect(manualFxImportSchema.safeParse({ rows: [row, { ...row, base: "KRW", quote: "USD", rate: "0.0008" }] }).success).toBe(false);
    expect(manualFxImportSchema.safeParse({ rows: [row, { ...row, date: "2024-01-03", rate: "invalid" }] }).success).toBe(false);
    expect(manualFxImportSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(manualFxImportSchema.safeParse({ rows: Array.from({ length: 2001 }, (_, index) => ({
      ...row, date: new Date(Date.UTC(2010, 0, index + 1)).toISOString().slice(0, 10),
    })) }).success).toBe(false);
  });

  it("accepts CSV labels as alternative price identifiers and preserves numeric stock symbols", () => {
    const row = { symbol: "005930", exchange: " kospi ", date: "2024-01-02", close: "80000", currency: "KRW" };
    const parsed = manualPriceImportSchema.parse({ rows: [row] });
    expect(parsed.rows[0]).toMatchObject({ symbol: "005930", exchange: "KOSPI" });
    expect(parsed.rows[0].assetId).toBeUndefined();
    expect(manualPriceImportSchema.safeParse({ rows: [{ ...row, assetId: "asset-1" }] }).success).toBe(true);
  });

  it("rejects missing/partial identifiers, mismatched shapes and normalized duplicate labels", () => {
    const fields = { date: "2024-01-02", close: "123", currency: "USD" };
    for (const identifiers of [
      {}, { symbol: "IBM" }, { exchange: "NYSE" }, { assetId: "asset-1", symbol: "IBM" },
      { assetId: "asset-1", exchange: "NYSE" }, { symbol: "", exchange: "NYSE" },
      { symbol: "IBM", exchange: " " }, { symbol: 123, exchange: "NYSE" },
      { symbol: "IBM", exchange: "NYSE", source: "DEMO" },
    ]) expect(manualPriceImportSchema.safeParse({ rows: [{ ...fields, ...identifiers }] }).success).toBe(false);
    expect(manualPriceImportSchema.safeParse({ rows: [
      { ...fields, symbol: "IBM", exchange: "NYSE" }, { ...fields, symbol: " ibm ", exchange: "nyse" },
    ] }).success).toBe(false);
    expect(manualPriceImportSchema.safeParse({ rows: [
      { ...fields, symbol: "IBM", exchange: "NYSE" }, { ...fields, symbol: "MSFT", exchange: "NASDAQ" },
    ] }).success).toBe(true);
  });
});

describe("guarded provider HTTP transport", () => {
  it("retries only up to three physical requests and caps Retry-After backoff", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "600" }))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ ok: true }));
    const sleep = vi.fn(async () => undefined);
    const beforeRequest = vi.fn(async () => undefined);
    const result = await new ProviderHttpClient({ fetch: fetcher, sleep, beforeRequest }).get(
      new URL("https://example.invalid/data"), z.object({ ok: z.boolean() }),
    );
    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(beforeRequest).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[5000], [500]]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
  });

  it("honors date-form Retry-After", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 503, { "retry-after": "Tue, 02 Jan 2024 00:00:02 GMT" }))
      .mockResolvedValueOnce(json({ ok: true }));
    const sleep = vi.fn(async () => undefined);
    await new ProviderHttpClient({
      fetch: fetcher, sleep, now: () => new Date("2024-01-02T00:00:00Z"),
    }).get(new URL("https://example.invalid/data"), z.object({ ok: z.boolean() }));
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("times out and aborts all three attempts even if a fetch ignores abort", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    const promise = new ProviderHttpClient({
      fetch: fetcher, timeoutMs: 10, sleep: async () => undefined,
    }).get(new URL("https://example.invalid/data"), z.object({}));
    const assertion = expect(promise).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", status: 504 });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it("retains a typed final error and never exposes network error messages", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("apikey=must-not-be-exposed"));
    const request = new ProviderHttpClient({ fetch: fetcher, sleep: async () => undefined })
      .get(new URL("https://example.invalid/data"), z.object({}));
    await expect(request).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(request).rejects.not.toThrow("must-not-be-exposed");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([
    [() => json({}, 404), "PROVIDER_HTTP_ERROR"],
    [() => new Response("<html>bad upstream</html>"), "PROVIDER_INVALID_RESPONSE"],
    [() => json({ wrong: "shape" }), "PROVIDER_INVALID_RESPONSE"],
    [() => json({ ok: true }, 200, { "content-length": "1000000" }), "PROVIDER_RESPONSE_TOO_LARGE"],
    [() => new Response("x".repeat(128)), "PROVIDER_RESPONSE_TOO_LARGE"],
  ])("does not retry permanent/malformed/oversized responses", async (response, code) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response());
    await expect(new ProviderHttpClient({ fetch: fetcher, maxBodyBytes: 64 }).get(
      new URL("https://example.invalid/data"), z.object({ ok: z.boolean() }),
    )).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops before an outbound request when the shared budget denies it", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new ProviderHttpClient({
      fetch: fetcher,
      beforeRequest: async () => { throw new ProviderError("PROVIDER_QUOTA_EXCEEDED", "Budget exhausted.", false, 429); },
    }).get(new URL("https://example.invalid/data"), z.object({}))).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXCEEDED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Frankfurter ECB adapter", () => {
  it("uses the explicit ECB v2 array route, exact observation dates and string-valued rates", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fxRows));
    const rows = await new FrankfurterProvider({
      fetch: fetcher, now: () => new Date("2024-01-08T12:00:00Z"),
    }).getFx({ ...fxRequest, to: "2024-01-07" }, context);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://api.frankfurter.dev/v2/providers/ecb/rates");
    expect(Object.fromEntries(url.searchParams)).toEqual({ base: "USD", quotes: "KRW", from: "2024-01-02", to: "2024-01-07" });
    expect(rows).toEqual(fxRows.map(row => ({
      ...row, rate: String(row.rate), source: "FRANKFURTER", fetchedAt: "2024-01-08T12:00:00.000Z",
    })));
    expect(rows.some(row => row.date === "2024-01-06" || row.date === "2024-01-07")).toBe(false);
  });

  it("supports a requested inverse pair without swapping the observed pair or fabricating a reciprocal", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json([
      { date: "2024-01-02", base: "KRW", quote: "USD", rate: 0.0007615 },
    ]));
    const rows = await new FrankfurterProvider({ fetch: fetcher }).getFx({ ...fxRequest, base: "KRW", quote: "USD" }, context);
    expect(rows[0]).toMatchObject({ base: "KRW", quote: "USD", rate: "0.0007615" });
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("base")).toBe("KRW");
  });

  it.each([
    { rates: { "2024-01-02": { KRW: 1313.23 } } },
    [{ date: "2024-01-02", base: "KRW", quote: "USD", rate: 0.0007615 }],
    [{ date: "2024-01-02", base: "USD", quote: "KRW", rate: "1313.23" }],
    [{ date: "2024-01-02", base: "USD", quote: "KRW", rate: 0 }],
    [{ date: "2024-02-30", base: "USD", quote: "KRW", rate: 1313.23 }],
    [{ date: "2024-01-01", base: "USD", quote: "KRW", rate: 1313.23 }],
    [fxRows[0], fxRows[0]],
  ].map(body => [body]))("rejects malformed, mismatched or duplicate response observations", async body => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body));
    await expect(new FrankfurterProvider({ fetch: fetcher }).getFx(fxRequest, context))
      .rejects.toMatchObject({ code: "PROVIDER_INVALID_RESPONSE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports empty ranges and unsupported pre-ECB history explicitly", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json([]));
    const provider = new FrankfurterProvider({ fetch: fetcher });
    await expect(provider.getFx(fxRequest, context)).rejects.toMatchObject({ code: "PROVIDER_NO_DATA" });
    await expect(provider.getFx({ ...fxRequest, from: "1999-01-01", to: "1999-01-05" }, context))
      .rejects.toMatchObject({ code: "PROVIDER_HISTORY_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("optional Alpha Vantage raw daily prices", () => {
  it("requires both a server-side key and explicit license acknowledgement", () => {
    vi.stubEnv("ALPHA_VANTAGE_API_KEY", "");
    vi.stubEnv("ALPHA_VANTAGE_LICENSE_ACK", "false");
    expect(() => new AlphaVantageProvider()).toThrow(expect.objectContaining({ code: "PROVIDER_NOT_CONFIGURED" }));
    expect(() => new AlphaVantageProvider({ apiKey: "test-key" })).toThrow(expect.objectContaining({ code: "PROVIDER_LICENSE_REQUIRED" }));
  });

  it("fetches compact raw closes only, preserving dates and provenance", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(daily));
    const rows = await new AlphaVantageProvider({ ...avOptions, fetch: fetcher }).getPrices(priceRequest, context);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.get("function")).toBe("TIME_SERIES_DAILY");
    expect(url.searchParams.get("outputsize")).toBe("compact");
    expect(url.searchParams.get("datatype")).toBe("json");
    expect(url.searchParams.get("symbol")).toBe("IBM");
    expect(rows.map(row => [row.date, row.close, row.adjustment, row.source])).toEqual([
      ["2024-01-02", "161.5000", "RAW", "ALPHA_VANTAGE"],
      ["2024-01-05", "163.0000", "RAW", "ALPHA_VANTAGE"],
    ]);
  });

  it.each<Partial<ProviderAsset>>([
    { currency: "KRW" }, { country: "KR" }, { country: null }, { assetClass: "CRYPTO" },
    { assetClass: "CUSTOM" }, { provider: "MANUAL" }, { exchange: "KOSPI" }, { exchange: "UNKNOWN" },
    { symbol: "IBM&apikey=other" },
  ])("does not guess Korean/crypto/custom or unconfigured coverage", async patch => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new AlphaVantageProvider({ ...avOptions, fetch: fetcher }).getPrices({
      ...priceRequest, asset: { ...asset, ...patch },
    }, context)).rejects.toMatchObject({ code: "PROVIDER_UNSUPPORTED_ASSET" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses uncovered historical starts instead of falling back to premium or partial data", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(daily));
    await expect(new AlphaVantageProvider({ ...avOptions, fetch: fetcher }).getPrices({
      ...priceRequest, from: "2023-12-29",
    }, context)).rejects.toMatchObject({ code: "PROVIDER_HISTORY_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("outputsize")).toBe("compact");
  });

  it("does not treat adjusted-only payloads or another symbol as raw prices", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({
        "Meta Data": { "2. Symbol": "IBM" },
        "Time Series (Daily)": { "2024-01-02": { "5. adjusted close": "100" } },
      }))
      .mockResolvedValueOnce(json({ ...daily, "Meta Data": { "2. Symbol": "MSFT" } }));
    const provider = new AlphaVantageProvider({ ...avOptions, fetch: fetcher });
    await expect(provider.getPrices(priceRequest, context)).rejects.toMatchObject({ code: "PROVIDER_INVALID_RESPONSE" });
    await expect(provider.getPrices(priceRequest, context)).rejects.toMatchObject({ code: "PROVIDER_INVALID_RESPONSE" });
  });

  it("recognizes 200-status quota notices, bounds retries and never echoes provider payloads", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ Information: "API rate limit for apikey=do-not-echo" }));
    const result = new AlphaVantageProvider({
      ...avOptions, fetch: fetcher, sleep: async () => undefined,
    }).getPrices(priceRequest, context);
    await expect(result).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
    await expect(result).rejects.not.toThrow("do-not-echo");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe("explicit capabilities and demo isolation", () => {
  it("fails unsupported capabilities instead of reporting empty success", async () => {
    const providers = [new FrankfurterProvider(), new AlphaVantageProvider(avOptions), new ManualProvider(), new DemoProvider()];
    for (const provider of providers) {
      await expect(provider.getDividends(priceRequest, context)).rejects.toMatchObject({ code: "PROVIDER_UNSUPPORTED" });
      await expect(provider.getCorporateActions(priceRequest, context)).rejects.toMatchObject({ code: "PROVIDER_UNSUPPORTED" });
    }
    await expect(new FrankfurterProvider().getPrices(priceRequest, context)).rejects.toMatchObject({ code: "PROVIDER_UNSUPPORTED" });
    await expect(new ManualProvider().getFx(fxRequest, context)).rejects.toMatchObject({ code: "PROVIDER_UNSUPPORTED" });
  });

  it("never falls back to demo and labels synthetic observations only for demo users", async () => {
    expect(() => createMarketDataProvider("DEMO", context)).toThrow(expect.objectContaining({ code: "PROVIDER_DEMO_FORBIDDEN" }));
    expect(() => createMarketDataProvider("COINBASE" as ProviderId, context)).toThrow(expect.objectContaining({ code: "PROVIDER_UNSUPPORTED" }));
    const demo = new DemoProvider();
    await expect(demo.getPrices(priceRequest, context)).rejects.toMatchObject({ code: "PROVIDER_DEMO_FORBIDDEN" });
    await expect(demo.getFx(fxRequest, context)).rejects.toMatchObject({ code: "PROVIDER_DEMO_FORBIDDEN" });
    const rows = await demo.getPrices(priceRequest, { ...context, isDemo: true });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.source === "DEMO" && row.adjustment === "RAW")).toBe(true);
  });
});
