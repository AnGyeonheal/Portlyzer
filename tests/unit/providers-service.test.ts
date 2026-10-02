import { Prisma, type ProviderJob } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FxInput, PriceInput } from "../../src/lib/domain";
import type { MarketDataProvider } from "../../src/lib/providers";

const database = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  user: { findUnique: vi.fn(), update: vi.fn() },
  asset: { findFirst: vi.fn(), findMany: vi.fn() },
  price: { upsert: vi.fn(), findUniqueOrThrow: vi.fn() },
  fxRate: { upsert: vi.fn(), deleteMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  providerJob: {
    findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn(),
  },
}));
vi.mock("../../src/lib/db", () => ({ db: database }));
vi.mock("../../src/lib/providers", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/lib/providers")>(),
  createMarketDataProvider: vi.fn(),
}));
vi.mock("../../src/lib/providers/rate-limit", () => ({ consumeProviderRequest: vi.fn(async () => undefined) }));

import { createMarketDataProvider, ProviderError } from "../../src/lib/providers";
import {
  importManualFx, importManualPrices, MARKET_CACHE_MS, MARKET_JOB_TIMEOUT_MS, refreshMarketData,
  upsertManualFx, upsertManualPrice,
} from "../../src/lib/services/market";

const userId = "user-1";
const request = { provider: "FRANKFURTER", from: "2024-01-02", to: "2024-01-05" };
const manualPrice = { assetId: "asset-1", date: "2024-01-02", close: "123.456", currency: "USD" };
const fx: FxInput[] = [{
  date: "2024-01-02", base: "USD", quote: "KRW", rate: "1313.23",
  source: "FRANKFURTER", fetchedAt: "2024-01-08T12:00:00.000Z",
}];
const provider: MarketDataProvider = {
  id: "FRANKFURTER",
  capabilities: { prices: false, fx: true, dividends: false, corporateActions: false },
  getPrices: vi.fn(), getFx: vi.fn(), getDividends: vi.fn(), getCorporateActions: vi.fn(),
};
let job: ProviderJob;

function existingJob(patch: Partial<ProviderJob> = {}): ProviderJob {
  return {
    id: "existing-job", userId, provider: "FRANKFURTER", status: "SUCCEEDED",
    requestKey: "old-key", from: new Date("2024-01-02"), to: new Date("2024-01-05"),
    count: 1, errorCode: null, message: null, startedAt: new Date(), finishedAt: new Date(),
    ...patch,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  database.$transaction.mockImplementation(async (callback: (tx: typeof database) => unknown) => callback(database));
  database.$queryRaw.mockResolvedValue([{ id: userId }]);
  database.$executeRaw.mockResolvedValue(1);
  database.user.findUnique.mockResolvedValue({ id: userId, isDemo: false });
  database.user.update.mockResolvedValue({ id: userId });
  database.asset.findMany.mockResolvedValue([{ id: manualPrice.assetId, symbol: "IBM", exchange: "NYSE", currency: "USD" }]);
  database.asset.findFirst.mockResolvedValue({
    id: manualPrice.assetId, userId, symbol: "IBM", name: "IBM", exchange: "NYSE",
    currency: "USD", country: "US", sector: null, assetClass: "STOCK", provider: "ALPHA_VANTAGE",
  });
  database.providerJob.findUnique.mockResolvedValue(null);
  database.providerJob.create.mockImplementation(async ({ data }: { data: Partial<ProviderJob> }) => {
    job = existingJob({ ...data, id: "new-job", count: 0, status: "RUNNING", finishedAt: null });
    return { ...job };
  });
  database.providerJob.updateMany.mockImplementation(async ({ data }: { data: Partial<ProviderJob> }) => {
    job = { ...job, ...data };
    return { count: 1 };
  });
  database.providerJob.findUniqueOrThrow.mockImplementation(async () => job);
  database.price.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
    id: "price-1", ...create, close: new Prisma.Decimal(String(create.close)),
  }));
  database.fxRate.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
    id: "fx-1", ...create, rate: new Prisma.Decimal(String(create.rate)),
  }));
  database.price.findUniqueOrThrow.mockResolvedValue({
    id: "price-1", ...manualPrice, date: new Date(manualPrice.date),
    close: new Prisma.Decimal(manualPrice.close), source: "MANUAL", adjustment: "RAW", fetchedAt: new Date(),
  });
  database.fxRate.findUniqueOrThrow.mockResolvedValue({
    id: "fx-1", date: new Date(manualPrice.date), base: "KRW", quote: "USD",
    rate: new Prisma.Decimal("0.0008"), source: "MANUAL", fetchedAt: new Date(),
  });
  vi.mocked(provider.getFx).mockResolvedValue(fx);
  vi.mocked(createMarketDataProvider).mockReturnValue(provider);
});

describe("owned manual market writes", () => {
  it("stores only owned raw MANUAL prices and invalidates analysis", async () => {
    const result = await upsertManualPrice(userId, manualPrice);
    expect(result).toMatchObject({ ...manualPrice, id: "price-1", source: "MANUAL", adjustment: "RAW" });
    expect(database.asset.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId, id: { in: ["asset-1"] } },
    }));
    expect(database.price.findUniqueOrThrow).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_assetId_date_source: {
        userId, assetId: "asset-1", date: new Date("2024-01-02"), source: "MANUAL",
      } },
    }));
    expect(database.$executeRaw).toHaveBeenCalledTimes(1);
    expect(database.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: userId }, data: { ledgerVersion: { increment: 1 } },
    }));
  });

  it("validates an entire import and all ownership/currencies before persistence", async () => {
    await expect(importManualPrices(userId, { rows: [
      manualPrice, { ...manualPrice, date: "2024-01-03", close: "1e3" },
    ] })).rejects.toThrow();
    expect(database.$transaction).not.toHaveBeenCalled();
    await expect(importManualPrices(userId, { rows: [
      manualPrice, { ...manualPrice, assetId: "foreign-asset", date: "2024-01-03" },
    ] })).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    expect(database.$executeRaw).not.toHaveBeenCalled();
    expect(database.user.update).not.toHaveBeenCalled();
    database.asset.findMany.mockResolvedValue([{ id: manualPrice.assetId, symbol: "IBM", exchange: "NYSE", currency: "KRW" }]);
    await expect(upsertManualPrice(userId, manualPrice)).rejects.toMatchObject({ code: "ASSET_CURRENCY_MISMATCH" });
    expect(database.price.upsert).not.toHaveBeenCalled();
  });

  it("persists at most 2,000 prices in parameterized atomic batches with one version bump", async () => {
    const rows = Array.from({ length: 2000 }, (_, index) => ({
      ...manualPrice,
      date: new Date(Date.UTC(2010, 0, index + 1)).toISOString().slice(0, 10),
    }));
    expect(await importManualPrices(userId, { rows })).toEqual({ count: 2000, source: "MANUAL" });
    expect(database.$executeRaw).toHaveBeenCalledTimes(8);
    expect(database.$transaction).toHaveBeenCalledTimes(1);
    expect(database.user.update).toHaveBeenCalledTimes(1);
    const sql = database.$executeRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.sql).toContain('ON CONFLICT ("userId", "assetId", "date", "source")');
    expect(sql.values).toContain("123.456");
    expect(sql.sql).not.toContain("123.456");
  });

  it("preserves the entered FX orientation and removes only its opposite MANUAL override", async () => {
    const input = { date: "2024-01-02", base: "KRW", quote: "USD", rate: "0.0008" };
    expect(await upsertManualFx(userId, input)).toMatchObject({ ...input, source: "MANUAL" });
    expect(database.fxRate.deleteMany).toHaveBeenCalledWith({
      where: {
        userId, source: "MANUAL",
        OR: [
          { base: "KRW", quote: "USD", date: { in: [] } },
          { base: "USD", quote: "KRW", date: { in: [new Date("2024-01-02")] } },
        ],
      },
    });
    expect(database.fxRate.findUniqueOrThrow).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_date_base_quote_source: {
        userId, date: new Date("2024-01-02"), base: "KRW", quote: "USD", source: "MANUAL",
      } },
    }));
  });

  it("validates FX imports before any deletion and persists within one transaction", async () => {
    const row = { date: "2024-01-02", base: "USD", quote: "KRW", rate: "1313.23" };
    await expect(importManualFx(userId, { rows: [row, { ...row, date: "2024-01-03", rate: "bad" }] })).rejects.toThrow();
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(database.fxRate.deleteMany).not.toHaveBeenCalled();
    expect(await importManualFx(userId, { rows: [row] })).toEqual({ count: 1, source: "MANUAL" });
    expect(database.$transaction).toHaveBeenCalledTimes(1);
    expect(database.$executeRaw).toHaveBeenCalledTimes(1);
    expect(database.user.update).toHaveBeenCalledTimes(1);
    const sql = database.$executeRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.sql).toContain('ON CONFLICT ("userId", "date", "base", "quote", "source")');
    expect(sql.values).toContain("1313.23");
    expect(sql.sql).not.toContain("1313.23");
  });

  it("resolves CSV-style symbol/exchange rows only within the requested workspace", async () => {
    const input = { rows: [{ symbol: " ibm ", exchange: "nyse", date: manualPrice.date, close: manualPrice.close, currency: "USD" }] };
    expect(await importManualPrices(userId, input)).toEqual({ count: 1, source: "MANUAL" });
    expect(database.asset.findMany).toHaveBeenCalledWith({
      where: {
        userId, symbol: { equals: "IBM", mode: "insensitive" }, exchange: { equals: "NYSE", mode: "insensitive" },
      },
      select: { id: true, symbol: true, exchange: true, currency: true },
    });
    const sql = database.$executeRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.values).toContain("asset-1");
    expect(sql.values).not.toContain("IBM");
    expect(database.user.update).toHaveBeenCalledTimes(1);
  });

  it("accepts corroborating ID and label identifiers but rejects identifier mismatches", async () => {
    expect(await importManualPrices(userId, { rows: [{ ...manualPrice, symbol: "IBM", exchange: "NYSE" }] }))
      .toEqual({ count: 1, source: "MANUAL" });
    database.$executeRaw.mockClear();
    await expect(importManualPrices(userId, { rows: [{ ...manualPrice, symbol: "MSFT", exchange: "NASDAQ" }] }))
      .rejects.toMatchObject({ code: "ASSET_IDENTIFIER_MISMATCH", details: { row: 1 } });
    expect(database.$executeRaw).not.toHaveBeenCalled();
  });

  it("rejects ambiguous case-insensitive owned labels, while an explicit ID remains unambiguous", async () => {
    database.asset.findMany.mockResolvedValue([
      { id: "asset-1", symbol: "IBM", exchange: "NYSE", currency: "USD" },
      { id: "asset-2", symbol: "ibm", exchange: "nyse", currency: "USD" },
    ]);
    await expect(importManualPrices(userId, { rows: [{
      symbol: "IBM", exchange: "NYSE", date: manualPrice.date, close: "123", currency: "USD",
    }] })).rejects.toMatchObject({ code: "AMBIGUOUS_ASSET" });
    expect(database.$executeRaw).not.toHaveBeenCalled();
    expect(await importManualPrices(userId, { rows: [manualPrice] })).toEqual({ count: 1, source: "MANUAL" });
  });

  it("detects duplicates after resolving mixed ID and label identities before writing", async () => {
    await expect(importManualPrices(userId, { rows: [
      manualPrice, { symbol: "IBM", exchange: "NYSE", date: manualPrice.date, close: "124", currency: "USD" },
    ] })).rejects.toMatchObject({ code: "DUPLICATE_PRICE", details: { row: 2 } });
    expect(database.$executeRaw).not.toHaveBeenCalled();
    expect(database.user.update).not.toHaveBeenCalled();
  });

  it("requires both native currency and an owned asset for symbol-based imports", async () => {
    const row = { symbol: "IBM", exchange: "NYSE", date: manualPrice.date, close: "123", currency: "KRW" };
    await expect(importManualPrices(userId, { rows: [row] })).rejects.toMatchObject({ code: "ASSET_CURRENCY_MISMATCH" });
    await expect(importManualPrices(userId, { rows: [{ ...row, symbol: "FOREIGN", currency: "USD" }] }))
      .rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    await expect(importManualPrices(userId, { rows: [{ ...row, assetId: "foreign-asset", currency: "USD" }] }))
      .rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    expect(database.$executeRaw).not.toHaveBeenCalled();
  });
});

describe("durable refresh jobs and cache", () => {
  it("stores provider observations separately from manual data with provenance", async () => {
    const result = await refreshMarketData(userId, request);
    expect(result).toMatchObject({ id: "new-job", status: "SUCCEEDED", count: 1, errorCode: null });
    expect(provider.getFx).toHaveBeenCalledWith(
      { from: request.from, to: request.to, base: "USD", quote: "KRW" },
      { userId, isDemo: false },
    );
    expect(database.fxRate.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: {
        userId, ...fx[0], date: new Date(fx[0].date), fetchedAt: new Date(fx[0].fetchedAt),
      },
    }));
    expect(database.fxRate.deleteMany).not.toHaveBeenCalled();
    expect(database.user.update).toHaveBeenCalledTimes(1);
  });

  it("returns the same successful job within the rolling twelve-hour cache without fetching or writing", async () => {
    const cached = existingJob({ finishedAt: new Date(Date.now() - MARKET_CACHE_MS + 60_000) });
    database.providerJob.findUnique.mockResolvedValue(cached);
    expect(await refreshMarketData(userId, request)).toMatchObject({ id: cached.id, status: "SUCCEEDED" });
    expect(createMarketDataProvider).not.toHaveBeenCalled();
    expect(database.fxRate.upsert).not.toHaveBeenCalled();
    expect(database.user.update).not.toHaveBeenCalled();
    expect(database.providerJob.create).not.toHaveBeenCalled();
  });

  it("reports an already running concurrent refresh instead of inventing completion", async () => {
    database.providerJob.findUnique.mockResolvedValue(existingJob({ status: "RUNNING", finishedAt: null }));
    expect(await refreshMarketData(userId, request)).toMatchObject({ status: "RUNNING" });
    expect(provider.getFx).not.toHaveBeenCalled();
    expect(database.providerJob.create).not.toHaveBeenCalled();
  });

  it("coalesces concurrent equal calls while the first fetch is in flight", async () => {
    let resolve: (rows: FxInput[]) => void = () => undefined;
    vi.mocked(provider.getFx).mockImplementation(() => new Promise<FxInput[]>(done => { resolve = done; }));
    const first = refreshMarketData(userId, request);
    await vi.waitFor(() => expect(provider.getFx).toHaveBeenCalledTimes(1));
    database.providerJob.findUnique.mockResolvedValue({ ...job });
    const second = await refreshMarketData(userId, request);
    expect(second).toMatchObject({ id: job.id, status: "RUNNING" });
    resolve(fx);
    expect(await first).toMatchObject({ id: second.id, status: "SUCCEEDED" });
    expect(provider.getFx).toHaveBeenCalledTimes(1);
  });

  it("marks stale RUNNING jobs failed and retains them when claiming a new job", async () => {
    const stale = existingJob({
      status: "RUNNING", finishedAt: null, startedAt: new Date(Date.now() - MARKET_JOB_TIMEOUT_MS - 1000),
    });
    database.providerJob.findUnique.mockResolvedValue(stale);
    expect(await refreshMarketData(userId, request)).toMatchObject({ id: "new-job", status: "SUCCEEDED" });
    expect(database.providerJob.update).toHaveBeenCalledWith({
      where: { id: stale.id },
      data: expect.objectContaining({
        status: "FAILED", errorCode: "PROVIDER_JOB_TIMEOUT",
        requestKey: expect.stringContaining(`:${stale.id}`),
      }),
    });
  });

  it("retains expired successful jobs when refreshing beyond the cache window", async () => {
    const old = existingJob({ finishedAt: new Date(Date.now() - MARKET_CACHE_MS - 1000) });
    database.providerJob.findUnique.mockResolvedValue(old);
    await refreshMarketData(userId, request);
    expect(database.providerJob.update).toHaveBeenCalledWith({
      where: { id: old.id }, data: { requestKey: expect.stringContaining(`:${old.id}`) },
    });
  });

  it("retains failure jobs and raises a typed error containing the job ID without writing data or demo fallback", async () => {
    vi.mocked(provider.getFx).mockRejectedValue(new ProviderError("PROVIDER_UNAVAILABLE", "Provider temporarily unavailable.", true));
    await expect(refreshMarketData(userId, request)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE", details: { jobId: "new-job" },
    });
    expect(database.providerJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "new-job", userId, status: "RUNNING" },
      data: expect.objectContaining({ status: "FAILED", errorCode: "PROVIDER_UNAVAILABLE" }),
    }));
    expect(database.fxRate.upsert).not.toHaveBeenCalled();
    expect(database.user.update).not.toHaveBeenCalled();
    expect(createMarketDataProvider).toHaveBeenCalledTimes(1);
    expect(createMarketDataProvider).toHaveBeenCalledWith("FRANKFURTER", expect.anything(), expect.anything());
  });

  it("caches failures briefly to prevent concurrent retry storms without claiming success", async () => {
    database.providerJob.findUnique.mockResolvedValue(existingJob({
      status: "FAILED", errorCode: "PROVIDER_RATE_LIMITED", message: "Provider rate limit.",
    }));
    await expect(refreshMarketData(userId, request)).rejects.toMatchObject({
      status: 429, code: "PROVIDER_RATE_LIMITED", details: { jobId: "existing-job" },
    });
    expect(createMarketDataProvider).not.toHaveBeenCalled();
  });

  it("records missing-key failures instead of returning an empty successful job", async () => {
    vi.mocked(createMarketDataProvider).mockImplementation(() => {
      throw new ProviderError("PROVIDER_NOT_CONFIGURED", "Set the optional key.", false, 503);
    });
    await expect(refreshMarketData(userId, {
      provider: "ALPHA_VANTAGE", from: request.from, to: request.to, assetId: manualPrice.assetId,
    })).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED", details: { jobId: "new-job" } });
    expect(job.status).toBe("FAILED");
    expect(provider.getFx).not.toHaveBeenCalled();
  });

  it("does not save late results from a timed-out/superseded job", async () => {
    database.providerJob.updateMany.mockResolvedValue({ count: 0 });
    await expect(refreshMarketData(userId, request)).rejects.toMatchObject({
      code: "PROVIDER_JOB_TIMEOUT", details: { jobId: "new-job" },
    });
    expect(database.fxRate.upsert).not.toHaveBeenCalled();
    expect(database.user.update).not.toHaveBeenCalled();
  });

  it("rejects foreign assets before creating any job", async () => {
    database.asset.findFirst.mockResolvedValue(null);
    await expect(refreshMarketData(userId, {
      ...request, provider: "ALPHA_VANTAGE", assetId: "foreign-asset",
    })).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
    expect(database.providerJob.create).not.toHaveBeenCalled();
    expect(createMarketDataProvider).not.toHaveBeenCalled();
  });

  it("requires a nonempty provider result and never returns fake success", async () => {
    vi.mocked(provider.getFx).mockResolvedValue([]);
    await expect(refreshMarketData(userId, request)).rejects.toMatchObject({ code: "PROVIDER_NO_DATA", details: { jobId: "new-job" } });
    expect(job.status).toBe("FAILED");
    expect(database.user.update).not.toHaveBeenCalled();
  });

  it("still reports the durable job ID if the database becomes unavailable while recording a failure", async () => {
    vi.mocked(provider.getFx).mockRejectedValue(new ProviderError("PROVIDER_UNAVAILABLE", "Provider unavailable."));
    database.providerJob.updateMany.mockRejectedValue(new Error("database password must not leak"));
    await expect(refreshMarketData(userId, request)).rejects.toMatchObject({
      status: 503, code: "PROVIDER_JOB_STATE_UNAVAILABLE",
      details: { jobId: "new-job", originalCode: "PROVIDER_UNAVAILABLE" },
    });
    expect(database.fxRate.upsert).not.toHaveBeenCalled();
  });

  it("rejects results if an asset identity changes while the provider is running", async () => {
    database.asset.findFirst
      .mockResolvedValueOnce({
        id: "asset-1", userId, symbol: "IBM", name: "IBM", exchange: "NYSE", currency: "USD",
        country: "US", sector: null, assetClass: "STOCK", provider: "ALPHA_VANTAGE",
      })
      .mockResolvedValueOnce({
        id: "asset-1", userId, symbol: "MSFT", name: "Microsoft", exchange: "NASDAQ", currency: "USD",
        country: "US", sector: null, assetClass: "STOCK", provider: "ALPHA_VANTAGE",
      });
    vi.mocked(provider.getPrices).mockResolvedValue([{
      assetId: "asset-1", date: manualPrice.date, close: "161.5", currency: "USD",
      adjustment: "RAW", source: "ALPHA_VANTAGE", fetchedAt: fx[0].fetchedAt,
    }]);
    await expect(refreshMarketData(userId, {
      ...request, provider: "ALPHA_VANTAGE", assetId: "asset-1",
    })).rejects.toMatchObject({ code: "PROVIDER_ASSET_CHANGED", details: { jobId: "new-job" } });
    expect(database.price.upsert).not.toHaveBeenCalled();
    expect(database.user.update).not.toHaveBeenCalled();
  });

  it("saves only the requested user's asset and RAW provider source", async () => {
    const prices: PriceInput[] = [{
      assetId: manualPrice.assetId, date: manualPrice.date, close: "161.5",
      currency: "USD", adjustment: "RAW", source: "ALPHA_VANTAGE", fetchedAt: fx[0].fetchedAt,
    }];
    vi.mocked(provider.getPrices).mockResolvedValue(prices);
    const result = await refreshMarketData(userId, {
      ...request, provider: "ALPHA_VANTAGE", assetId: manualPrice.assetId,
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(database.price.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ userId, assetId: manualPrice.assetId, adjustment: "RAW", source: "ALPHA_VANTAGE" }),
    }));
    expect(database.asset.findFirst).toHaveBeenCalledWith({ where: { userId, id: manualPrice.assetId } });
  });
});
