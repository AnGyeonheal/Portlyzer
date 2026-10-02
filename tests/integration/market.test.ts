import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/lib/db";
import { consumeProviderRequest } from "../../src/lib/providers/rate-limit";
import {
  importManualFx, importManualPrices, MARKET_CACHE_MS, MARKET_JOB_TIMEOUT_MS, refreshMarketData,
  upsertManualFx, upsertManualPrice,
} from "../../src/lib/services/market";

describe.runIf(process.env.RUN_INTEGRATION === "1")("owned market data and durable jobs (PostgreSQL)", () => {
  let userId: string;
  let assetId: string;
  let userIds: string[];
  let budgetPrefix: string;

  const dailyResponse = (close = "161.5000") => Response.json({
    "Meta Data": { "2. Symbol": "IBM" },
    "Time Series (Daily)": {
      "2024-01-02": { "4. close": close },
      "2024-01-03": { "4. close": "160.2000" },
    },
  });
  const request = () => ({
    provider: "ALPHA_VANTAGE", assetId, from: "2024-01-02", to: "2024-01-03",
  });
  const createUser = async () => {
    const id = `market-test-${randomUUID()}`;
    userIds.push(id);
    await db.user.create({ data: { id, email: `${id}@example.invalid`, name: "Market integration test" } });
    return id;
  };

  beforeAll(async () => {
    if (existsSync(".env")) process.loadEnvFile(".env");
    await db.$connect();
  });

  beforeEach(async () => {
    userIds = [];
    const fakeKey = `market-test-key-${randomUUID()}`;
    budgetPrefix = `market:ALPHA_VANTAGE:${createHash("sha256").update(fakeKey).digest("hex").slice(0, 24)}`;
    vi.stubEnv("ALPHA_VANTAGE_API_KEY", fakeKey);
    vi.stubEnv("ALPHA_VANTAGE_LICENSE_ACK", "true");
    userId = await createUser();
    const asset = await db.asset.create({
      data: {
        userId, symbol: "IBM", name: "IBM test", currency: "USD",
        assetClass: "STOCK", exchange: "NYSE", country: "US", provider: "ALPHA_VANTAGE",
      },
    });
    assetId = asset.id;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => dailyResponse());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (userIds?.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
    if (budgetPrefix) await db.apiRateLimit.deleteMany({ where: { key: { startsWith: budgetPrefix } } });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("upserts owned MANUAL raw prices, enforces currency/ownership and invalidates analysis", async () => {
    const row = { assetId, date: "2024-01-02", close: "123.456789012345", currency: "USD" };
    const first = await upsertManualPrice(userId, row);
    const second = await upsertManualPrice(userId, { ...row, close: "124" });
    expect(first.id).toBe(second.id);
    expect(first.close).toBe("123.456789012345");
    expect(await db.price.count({ where: { userId } })).toBe(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).ledgerVersion).toBe(2);
    const foreignId = await createUser();
    await expect(upsertManualPrice(foreignId, row)).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    await expect(upsertManualPrice(userId, { ...row, currency: "KRW" })).rejects.toMatchObject({ code: "ASSET_CURRENCY_MISMATCH" });
    expect(await db.price.count({ where: { userId: foreignId } })).toBe(0);
    expect((await db.price.findUniqueOrThrow({ where: { id: second.id } })).source).toBe("MANUAL");
  });

  it("validates a whole import before persistence and accepts the 2,000-row atomic bound", async () => {
    const row = { assetId, date: "2024-01-02", close: "100", currency: "USD" };
    await expect(importManualPrices(userId, {
      rows: [row, { ...row, assetId: "not-owned", date: "2024-01-03" }],
    })).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    expect(await db.price.count({ where: { userId } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).ledgerVersion).toBe(0);
    const rows = Array.from({ length: 2000 }, (_, index) => ({
      ...row, date: new Date(Date.UTC(2010, 0, index + 1)).toISOString().slice(0, 10),
    }));
    expect(await importManualPrices(userId, { rows })).toEqual({ count: 2000, source: "MANUAL" });
    expect(await db.price.count({ where: { userId, source: "MANUAL" } })).toBe(2000);
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).ledgerVersion).toBe(1);
    const first = await db.price.findFirstOrThrow({ where: { userId, date: new Date(rows[0].date) } });
    await importManualPrices(userId, { rows: [{ ...rows[0], close: "200" }] });
    expect((await db.price.findUniqueOrThrow({ where: { id: first.id } })).close.toFixed()).toBe("200");
    expect(await db.price.count({ where: { userId } })).toBe(2000);
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).ledgerVersion).toBe(2);
  });

  it("imports historical CSV-shaped prices by owned symbol/exchange and updates the same raw record", async () => {
    const otherUser = await createUser();
    const otherAsset = await db.asset.create({ data: {
      userId: otherUser, symbol: "IBM", name: "Other user's IBM", exchange: "NYSE", currency: "USD", assetClass: "STOCK",
    } });
    const rows = [
      { symbol: " ibm ", exchange: "nyse", date: "2024-01-02", close: "123.456789012345", currency: "USD" },
      { assetId, symbol: "IBM", exchange: "NYSE", date: "2024-01-03", close: "124", currency: "USD" },
    ];
    expect(await importManualPrices(userId, { rows })).toEqual({ count: 2, source: "MANUAL" });
    const prices = await db.price.findMany({ where: { userId }, orderBy: { date: "asc" } });
    expect(prices).toHaveLength(2);
    expect(prices.every(price => price.assetId === assetId && price.source === "MANUAL" && price.adjustment === "RAW")).toBe(true);
    expect(prices[0].close.toFixed()).toBe("123.456789012345");
    expect(await db.price.count({ where: { assetId: otherAsset.id } })).toBe(0);
    await importManualPrices(userId, { rows: [{ ...rows[0], close: "125" }] });
    expect((await db.price.findUniqueOrThrow({ where: { id: prices[0].id } })).close.toFixed()).toBe("125");
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).ledgerVersion).toBe(2);
  });

  it("rejects identifier conflicts, unresolved labels and post-resolution duplicates atomically", async () => {
    const original = await upsertManualPrice(userId, { assetId, date: "2024-01-02", close: "100", currency: "USD" });
    const valid = { symbol: "IBM", exchange: "NYSE", date: "2024-01-02", close: "200", currency: "USD" };
    await expect(importManualPrices(userId, { rows: [
      valid, { ...valid, assetId, symbol: "MSFT", exchange: "NASDAQ", date: "2024-01-03" },
    ] })).rejects.toMatchObject({ code: "ASSET_IDENTIFIER_MISMATCH", details: { row: 2 } });
    await expect(importManualPrices(userId, { rows: [
      valid, { ...valid, symbol: "MISSING", date: "2024-01-03" },
    ] })).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    await expect(importManualPrices(userId, { rows: [
      valid, { assetId, date: valid.date, close: "300", currency: "USD" },
    ] })).rejects.toMatchObject({ code: "DUPLICATE_PRICE", details: { row: 2 } });
    await expect(importManualPrices(userId, { rows: [{ ...valid, currency: "KRW" }] }))
      .rejects.toMatchObject({ code: "ASSET_CURRENCY_MISMATCH" });
    expect(await db.price.count({ where: { userId } })).toBe(1);
    expect((await db.price.findUniqueOrThrow({ where: { id: original.id } })).close.toFixed()).toBe("100");
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).ledgerVersion).toBe(1);
  });

  it("requires an explicit ID for case-insensitive ambiguous labels and rejects foreign-only matches", async () => {
    const duplicate = await db.asset.create({ data: {
      userId, symbol: "ibm", name: "Case variant", exchange: "nyse", currency: "USD", assetClass: "STOCK",
    } });
    const row = { symbol: "IBM", exchange: "NYSE", date: "2024-01-02", close: "100", currency: "USD" };
    await expect(importManualPrices(userId, { rows: [row] })).rejects.toMatchObject({ code: "AMBIGUOUS_ASSET" });
    expect(await db.price.count({ where: { userId } })).toBe(0);
    await importManualPrices(userId, { rows: [{ assetId: duplicate.id, date: row.date, close: row.close, currency: row.currency }] });
    expect((await db.price.findFirstOrThrow({ where: { userId } })).assetId).toBe(duplicate.id);
    const foreignUser = await createUser();
    const foreignAsset = await db.asset.create({ data: {
      userId: foreignUser, symbol: "FOREIGN", name: "Foreign workspace", exchange: "NYSE", currency: "USD", assetClass: "STOCK",
    } });
    await expect(importManualPrices(userId, { rows: [{ ...row, symbol: "FOREIGN" }] }))
      .rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    await expect(importManualPrices(userId, { rows: [{ ...row, assetId: foreignAsset.id, symbol: "FOREIGN" }] }))
      .rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    expect(await db.price.count({ where: { userId: foreignUser } })).toBe(0);
  });

  it("preserves inverse manual FX and never removes other users or provider observations", async () => {
    const date = new Date("2024-01-02T00:00:00Z");
    const otherUser = await createUser();
    await db.fxRate.createMany({ data: [
      { userId, date, base: "USD", quote: "KRW", rate: "1313.23", source: "FRANKFURTER" },
      { userId: otherUser, date, base: "USD", quote: "KRW", rate: "1400", source: "MANUAL" },
    ] });
    await upsertManualFx(userId, { date: "2024-01-02", base: "USD", quote: "KRW", rate: "1250" });
    await upsertManualFx(userId, { date: "2024-01-02", base: "KRW", quote: "USD", rate: "0.0008" });
    const rates = await db.fxRate.findMany({ where: { userId }, orderBy: { source: "asc" } });
    expect(rates).toHaveLength(2);
    expect(rates.find(rate => rate.source === "MANUAL")).toMatchObject({ base: "KRW", quote: "USD" });
    expect(rates.find(rate => rate.source === "FRANKFURTER")?.rate.toFixed()).toBe("1313.23");
    expect(await db.fxRate.count({ where: { userId: otherUser } })).toBe(1);
  });

  it("imports FX atomically with stable upsert IDs and replaces only opposite manual orientations", async () => {
    const original = await upsertManualFx(userId, { date: "2024-01-02", base: "USD", quote: "KRW", rate: "1300" });
    await db.fxRate.create({ data: {
      userId, date: new Date("2024-01-02"), base: "USD", quote: "KRW", rate: "1313.23", source: "FRANKFURTER",
    } });
    await expect(importManualFx(userId, { rows: [
      { date: "2024-01-02", base: "USD", quote: "KRW", rate: "1400" },
      { date: "2024-01-03", base: "USD", quote: "KRW", rate: "-1" },
    ] })).rejects.toThrow();
    expect((await db.fxRate.findUniqueOrThrow({ where: { id: original.id } })).rate.toFixed()).toBe("1300");
    await importManualFx(userId, { rows: [{ date: "2024-01-02", base: "USD", quote: "KRW", rate: "1400" }] });
    expect((await db.fxRate.findUniqueOrThrow({ where: { id: original.id } })).rate.toFixed()).toBe("1400");
    const rows = Array.from({ length: 2000 }, (_, index) => ({
      date: new Date(Date.UTC(2010, 0, index + 1)).toISOString().slice(0, 10),
      base: "USD", quote: "KRW", rate: "1300",
    }));
    rows[0] = { date: "2024-01-02", base: "KRW", quote: "USD", rate: "0.0008" };
    expect(await importManualFx(userId, { rows })).toEqual({ count: 2000, source: "MANUAL" });
    expect(await db.fxRate.count({ where: { userId, source: "MANUAL" } })).toBe(2000);
    expect(await db.fxRate.count({ where: { userId, source: "FRANKFURTER" } })).toBe(1);
    expect(await db.fxRate.findUnique({ where: { id: original.id } })).toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).ledgerVersion).toBe(3);
  });

  it("caches successful requests and stores automated prices separately from manual overrides", async () => {
    await upsertManualPrice(userId, { assetId, date: "2024-01-02", close: "999", currency: "USD" });
    const first = await refreshMarketData(userId, request());
    const second = await refreshMarketData(userId, request());
    expect(first).toMatchObject({ status: "SUCCEEDED", count: 2 });
    expect(second.id).toBe(first.id);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const prices = await db.price.findMany({ where: { userId }, orderBy: { source: "asc" } });
    expect(prices).toHaveLength(3);
    expect(prices.find(price => price.source === "MANUAL")?.close.toFixed()).toBe("999");
    expect(prices.filter(price => price.source === "ALPHA_VANTAGE").every(price => price.adjustment === "RAW")).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).ledgerVersion).toBe(2);
  });

  it("coalesces concurrent requests into a single job and outbound call", async () => {
    let finish: (response: Response) => void = () => undefined;
    vi.mocked(globalThis.fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    const first = refreshMarketData(userId, request());
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    const second = await refreshMarketData(userId, request());
    expect(second.status).toBe("RUNNING");
    finish(dailyResponse());
    const completed = await first;
    expect(completed).toMatchObject({ id: second.id, status: "SUCCEEDED" });
    expect(await db.providerJob.count({ where: { userId } })).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("retains failed jobs and existing prices instead of silently using demo data", async () => {
    await upsertManualPrice(userId, { assetId, date: "2024-01-02", close: "999", currency: "USD" });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json({ malformed: true }));
    await expect(refreshMarketData(userId, request())).rejects.toMatchObject({ code: "PROVIDER_INVALID_RESPONSE", details: { jobId: expect.any(String) } });
    const failed = await db.providerJob.findFirstOrThrow({ where: { userId } });
    expect(failed).toMatchObject({ status: "FAILED", errorCode: "PROVIDER_INVALID_RESPONSE", count: 0 });
    expect(await db.price.count({ where: { userId } })).toBe(1);
    expect(await db.price.count({ where: { userId, source: "DEMO" } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).ledgerVersion).toBe(1);
    await expect(refreshMarketData(userId, request())).rejects.toMatchObject({ details: { jobId: failed.id } });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await db.providerJob.update({ where: { id: failed.id }, data: { finishedAt: new Date(Date.now() - 31_000) } });
    expect((await refreshMarketData(userId, request())).status).toBe("SUCCEEDED");
    expect(await db.providerJob.count({ where: { userId } })).toBe(2);
    expect((await db.providerJob.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("FAILED");
  });

  it("records missing configuration as a failed job without making a request", async () => {
    vi.stubEnv("ALPHA_VANTAGE_API_KEY", "");
    await expect(refreshMarketData(userId, request())).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect((await db.providerJob.findFirstOrThrow({ where: { userId } })).status).toBe("FAILED");
    expect(await db.price.count({ where: { userId } })).toBe(0);
  });

  it("charges a physical retry to both shared and per-user budgets", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "0" } }));
    expect((await refreshMarketData(userId, request())).status).toBe("SUCCEEDED");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect((await db.apiRateLimit.findUniqueOrThrow({ where: { key: `${budgetPrefix}:global` } })).count).toBe(2);
    expect((await db.apiRateLimit.findUniqueOrThrow({ where: { key: `${budgetPrefix}:user:${userId}` } })).count).toBe(2);
  });

  it("archives stale jobs and fences out their late results", async () => {
    let finish: (response: Response) => void = () => undefined;
    vi.mocked(globalThis.fetch)
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockImplementationOnce(async () => dailyResponse("222"));
    const firstOutcome = refreshMarketData(userId, request()).catch(error => error);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    const stale = await db.providerJob.findFirstOrThrow({ where: { userId } });
    await db.providerJob.update({
      where: { id: stale.id }, data: { startedAt: new Date(Date.now() - MARKET_JOB_TIMEOUT_MS - 1000) },
    });
    const second = await refreshMarketData(userId, request());
    expect(second.status).toBe("SUCCEEDED");
    finish(dailyResponse("111"));
    expect(await firstOutcome).toMatchObject({ code: "PROVIDER_JOB_TIMEOUT", details: { jobId: stale.id } });
    expect((await db.providerJob.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("FAILED");
    const price = await db.price.findFirstOrThrow({ where: { userId, assetId, date: new Date("2024-01-02") } });
    expect(price.close.toFixed()).toBe("222");
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).ledgerVersion).toBe(1);
  });

  it("retains expired successful jobs and keeps requests user-owned", async () => {
    const first = await refreshMarketData(userId, request());
    await db.providerJob.update({
      where: { id: first.id }, data: { finishedAt: new Date(Date.now() - MARKET_CACHE_MS - 1000) },
    });
    const second = await refreshMarketData(userId, request());
    expect(second.id).not.toBe(first.id);
    expect(await db.providerJob.count({ where: { userId } })).toBe(2);
    const foreignUser = await createUser();
    await expect(refreshMarketData(foreignUser, request())).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    expect(await db.providerJob.count({ where: { userId: foreignUser } })).toBe(0);
  });

  it("atomically enforces a per-user budget under concurrency without partially charging the global budget", async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 15 }, () => consumeProviderRequest("ALPHA_VANTAGE", userId)));
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(10);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(5);
    const global = await db.apiRateLimit.findUniqueOrThrow({ where: { key: `${budgetPrefix}:global` } });
    const personal = await db.apiRateLimit.findUniqueOrThrow({ where: { key: `${budgetPrefix}:user:${userId}` } });
    expect(global.count).toBe(10);
    expect(personal.count).toBe(10);
  });

  it("shares the 25-request key allowance across users and resets expired windows atomically", async () => {
    const secondUser = await createUser();
    const thirdUser = await createUser();
    for (const [id, count] of [[userId, 10], [secondUser, 10], [thirdUser, 5]] as const) {
      for (let index = 0; index < count; index++) await consumeProviderRequest("ALPHA_VANTAGE", id);
    }
    await expect(consumeProviderRequest("ALPHA_VANTAGE", thirdUser)).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXCEEDED" });
    expect((await db.apiRateLimit.findUniqueOrThrow({ where: { key: `${budgetPrefix}:global` } })).count).toBe(25);
    expect((await db.apiRateLimit.findUniqueOrThrow({ where: { key: `${budgetPrefix}:user:${thirdUser}` } })).count).toBe(5);
    await db.apiRateLimit.updateMany({
      where: { key: { startsWith: budgetPrefix } }, data: { windowStart: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    await Promise.all(Array.from({ length: 5 }, () => consumeProviderRequest("ALPHA_VANTAGE", userId)));
    expect((await db.apiRateLimit.findUniqueOrThrow({ where: { key: `${budgetPrefix}:global` } })).count).toBe(5);
  });
});
