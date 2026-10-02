import { createHash, randomUUID } from "node:crypto";
import { Prisma, type ProviderJob } from "@prisma/client";
import type { JobDto } from "../contracts";
import { db } from "../db";
import type { Currency, FxInput, PriceInput } from "../domain";
import { AppError } from "../errors";
import { createMarketDataProvider, ProviderError, type ProviderAsset } from "../providers";
import { consumeProviderRequest } from "../providers/rate-limit";
import {
  manualFxImportSchema, manualFxSchema, manualPriceImportSchema, manualPriceSchema, refreshSchema,
  type ManualFx, type ManualPrice, type ManualPriceImportRow, type RefreshRequest,
} from "../providers/validation";

export const MARKET_CACHE_MS = 12 * 60 * 60 * 1000;
export const MARKET_JOB_TIMEOUT_MS = 2 * 60 * 1000;
const FAILURE_CACHE_MS = 30 * 1000;

function utcDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function priceDto(row: {
  id: string; assetId: string; date: Date; close: Prisma.Decimal; currency: Currency;
  source: string; fetchedAt: Date;
}): PriceInput & { id: string } {
  return {
    id: row.id, assetId: row.assetId, date: row.date.toISOString().slice(0, 10),
    close: row.close.toFixed(), currency: row.currency, source: row.source,
    fetchedAt: row.fetchedAt.toISOString(), adjustment: "RAW",
  };
}

export function marketJobDto(job: ProviderJob): JobDto {
  return {
    id: job.id, provider: job.provider, status: job.status,
    from: job.from.toISOString().slice(0, 10), to: job.to.toISOString().slice(0, 10),
    count: job.count, message: job.message, errorCode: job.errorCode,
    startedAt: job.startedAt.toISOString(), finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

async function lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const users = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE
  `);
  if (users.length !== 1) throw new AppError(404, "NOT_FOUND", "The user was not found.");
}

function assetLabelKey(symbol: string, exchange: string): string {
  return JSON.stringify([symbol.toUpperCase(), exchange.toUpperCase()]);
}

async function resolveOwnedPrices(
  tx: Prisma.TransactionClient, userId: string, rows: ManualPriceImportRow[],
): Promise<ManualPrice[]> {
  const ids = [...new Set(rows.flatMap(row => row.assetId ? [row.assetId] : []))];
  const labels = new Map<string, { symbol: string; exchange: string }>();
  for (const row of rows) {
    if (row.symbol && row.exchange) labels.set(assetLabelKey(row.symbol, row.exchange), { symbol: row.symbol, exchange: row.exchange });
  }
  const criteria: Prisma.AssetWhereInput[] = [
    ...(ids.length ? [{ id: { in: ids } }] : []),
    ...[...labels.values()].map(({ symbol, exchange }): Prisma.AssetWhereInput => ({
      symbol: { equals: symbol, mode: "insensitive" },
      exchange: { equals: exchange, mode: "insensitive" },
    })),
  ];
  type OwnedAsset = { id: string; symbol: string; exchange: string; currency: Currency };
  const byId = new Map<string, OwnedAsset>();
  for (let offset = 0; offset < criteria.length; offset += 250) {
    const batch = criteria.slice(offset, offset + 250);
    const assets = await tx.asset.findMany({
      where: { userId, ...(batch.length === 1 ? batch[0] : { OR: batch }) },
      select: { id: true, symbol: true, exchange: true, currency: true },
    });
    for (const asset of assets) byId.set(asset.id, asset);
  }
  const byLabel = new Map<string, OwnedAsset[]>();
  for (const asset of byId.values()) {
    const key = assetLabelKey(asset.symbol, asset.exchange);
    byLabel.set(key, [...(byLabel.get(key) ?? []), asset]);
  }
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const details = { row: index + 1 };
    const idAsset = row.assetId ? byId.get(row.assetId) : undefined;
    if (row.assetId && !idAsset) {
      throw new AppError(404, "ASSET_NOT_FOUND", "A selected asset was not found in this workspace.", details);
    }
    const label = row.symbol && row.exchange ? assetLabelKey(row.symbol, row.exchange) : undefined;
    const candidates = label ? byLabel.get(label) ?? [] : [];
    if (idAsset && label && assetLabelKey(idAsset.symbol, idAsset.exchange) !== label) {
      throw new AppError(422, "ASSET_IDENTIFIER_MISMATCH", "The asset ID and symbol/exchange identify different assets.", details);
    }
    if (label && candidates.length > 1) {
      throw new AppError(422, "AMBIGUOUS_ASSET", "Multiple owned assets match that symbol/exchange. Supply only the precise asset ID.", details);
    }
    const asset = idAsset ?? candidates[0];
    if (!asset) throw new AppError(404, "ASSET_NOT_FOUND", "A selected asset was not found in this workspace.", details);
    if (asset.currency !== row.currency) {
      throw new AppError(422, "ASSET_CURRENCY_MISMATCH", "A price must use the asset's native currency.");
    }
    const key = JSON.stringify([asset.id, row.date]);
    if (seen.has(key)) {
      throw new AppError(422, "DUPLICATE_PRICE", "Each resolved asset/date may appear only once per import.", details);
    }
    seen.add(key);
    return { assetId: asset.id, date: row.date, close: row.close, currency: row.currency };
  });
}

async function withManualWrite<T>(userId: string, action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async tx => {
    await lockUser(tx, userId);
    const result = await action(tx);
    await tx.user.update({ where: { id: userId }, data: { ledgerVersion: { increment: 1 } }, select: { id: true } });
    return result;
  }, { timeout: 30_000 });
}

async function writeManualPrices(tx: Prisma.TransactionClient, userId: string, rows: ManualPrice[]): Promise<void> {
  const fetchedAt = new Date();
  // Parameterized batches keep a 2,000-row import atomic without 2,000 database round trips.
  for (let offset = 0; offset < rows.length; offset += 250) {
    const values = rows.slice(offset, offset + 250).map(row => Prisma.sql`
      (${randomUUID()}, ${userId}, ${row.assetId}, ${utcDate(row.date)},
       ${row.close}::numeric, ${row.currency}::"Currency", 'RAW', 'MANUAL', ${fetchedAt})
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "Price" ("id", "userId", "assetId", "date", "close", "currency", "adjustment", "source", "fetchedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("userId", "assetId", "date", "source") DO UPDATE SET
        "close" = EXCLUDED."close", "currency" = EXCLUDED."currency",
        "adjustment" = 'RAW', "fetchedAt" = EXCLUDED."fetchedAt"
    `);
  }
}

async function writeManualFx(tx: Prisma.TransactionClient, userId: string, rows: ManualFx[]): Promise<void> {
  // Only one manual orientation may override a currency pair on a given observation date.
  await tx.fxRate.deleteMany({
    where: {
      userId, source: "MANUAL",
      OR: (["USD", "KRW"] as const).map(base => ({
        base: base === "USD" ? "KRW" : "USD",
        quote: base,
        date: { in: rows.filter(row => row.base === base).map(row => utcDate(row.date)) },
      })),
    },
  });
  const fetchedAt = new Date();
  for (let offset = 0; offset < rows.length; offset += 250) {
    const values = rows.slice(offset, offset + 250).map(row => Prisma.sql`
      (${randomUUID()}, ${userId}, ${utcDate(row.date)}, ${row.base}::"Currency",
       ${row.quote}::"Currency", ${row.rate}::numeric, 'MANUAL', ${fetchedAt})
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "FxRate" ("id", "userId", "date", "base", "quote", "rate", "source", "fetchedAt")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("userId", "date", "base", "quote", "source") DO UPDATE SET
        "rate" = EXCLUDED."rate", "fetchedAt" = EXCLUDED."fetchedAt"
    `);
  }
}

export async function upsertManualPrice(userId: string, input: unknown): Promise<PriceInput & { id: string }> {
  const row = manualPriceSchema.parse(input);
  return withManualWrite(userId, async tx => {
    const rows = await resolveOwnedPrices(tx, userId, [row]);
    await writeManualPrices(tx, userId, rows);
    const price = await tx.price.findUniqueOrThrow({
      where: { userId_assetId_date_source: { userId, assetId: row.assetId, date: utcDate(row.date), source: "MANUAL" } },
    });
    return priceDto(price);
  });
}

export async function importManualPrices(userId: string, input: unknown): Promise<{ count: number; source: "MANUAL" }> {
  const parsed = manualPriceImportSchema.parse(input);
  return withManualWrite(userId, async tx => {
    const rows = await resolveOwnedPrices(tx, userId, parsed.rows);
    await writeManualPrices(tx, userId, rows);
    return { count: rows.length, source: "MANUAL" };
  });
}

export async function upsertManualFx(userId: string, input: unknown): Promise<FxInput & { id: string }> {
  const row = manualFxSchema.parse(input);
  return withManualWrite(userId, async tx => {
    await writeManualFx(tx, userId, [row]);
    const rate = await tx.fxRate.findUniqueOrThrow({
      where: { userId_date_base_quote_source: { userId, date: utcDate(row.date), base: row.base, quote: row.quote, source: "MANUAL" } },
    });
    return {
      id: rate.id, date: rate.date.toISOString().slice(0, 10), base: rate.base, quote: rate.quote,
      rate: rate.rate.toFixed(), source: rate.source, fetchedAt: rate.fetchedAt.toISOString(),
    };
  });
}

export async function importManualFx(userId: string, input: unknown): Promise<{ count: number; source: "MANUAL" }> {
  const { rows } = manualFxImportSchema.parse(input);
  return withManualWrite(userId, async tx => {
    await writeManualFx(tx, userId, rows);
    return { count: rows.length, source: "MANUAL" };
  });
}

function requestKey(userId: string, input: RefreshRequest, asset: ProviderAsset | null): string {
  const fingerprint = JSON.stringify([
    userId, input.provider, input.from, input.to, input.assetId ?? null,
    asset && [asset.symbol, asset.exchange, asset.currency, asset.country, asset.assetClass, asset.provider],
  ]);
  return `market:v1:${createHash("sha256").update(fingerprint).digest("hex")}`;
}

async function claimJob(userId: string, input: RefreshRequest, asset: ProviderAsset | null): Promise<{ job: ProviderJob; acquired: boolean }> {
  const key = requestKey(userId, input, asset);
  return db.$transaction(async tx => {
    // Serializes job registration only; network work never holds this lock.
    await lockUser(tx, userId);
    const now = new Date();
    const existing = await tx.providerJob.findUnique({ where: { requestKey: key } });
    if (existing) {
      if (existing.userId !== userId) throw new AppError(409, "PROVIDER_JOB_CONFLICT", "This refresh could not be registered.");
      if (existing.status === "RUNNING" && existing.startedAt.getTime() > now.getTime() - MARKET_JOB_TIMEOUT_MS) {
        return { job: existing, acquired: false };
      }
      if (
        existing.status === "SUCCEEDED" && existing.finishedAt &&
        existing.finishedAt.getTime() > now.getTime() - MARKET_CACHE_MS
      ) return { job: existing, acquired: false };
      if (
        existing.status === "FAILED" && existing.finishedAt &&
        existing.finishedAt.getTime() > now.getTime() - FAILURE_CACHE_MS
      ) return { job: existing, acquired: false };
      await tx.providerJob.update({
        where: { id: existing.id },
        data: {
          requestKey: `${key}:${existing.id}`,
          ...(existing.status === "RUNNING" ? {
            status: "FAILED",
            errorCode: "PROVIDER_JOB_TIMEOUT",
            message: "The previous refresh exceeded its running time limit. Existing observations were retained.",
            finishedAt: now,
          } : {}),
        },
      });
    }
    const job = await tx.providerJob.create({
      data: {
        userId, provider: input.provider, status: "RUNNING", requestKey: key,
        from: utcDate(input.from), to: utcDate(input.to), startedAt: now,
      },
    });
    return { job, acquired: true };
  });
}

function storedJobError(job: ProviderJob): AppError {
  const code = job.errorCode ?? "PROVIDER_FAILED";
  const status = ["PROVIDER_RATE_LIMITED", "PROVIDER_QUOTA_EXCEEDED"].includes(code) ? 429 :
    ["PROVIDER_NOT_CONFIGURED", "PROVIDER_LICENSE_REQUIRED"].includes(code) ? 503 :
    ["PROVIDER_UNSUPPORTED_ASSET", "PROVIDER_HISTORY_UNAVAILABLE", "PROVIDER_NO_DATA", "PROVIDER_REQUEST_REJECTED"].includes(code) ? 422 :
    ["PROVIDER_JOB_TIMEOUT", "PROVIDER_ASSET_CHANGED"].includes(code) ? 409 :
    code === "PROVIDER_TIMEOUT" ? 504 : 502;
  return new AppError(status, code, job.message ?? "The provider refresh failed.", { jobId: job.id });
}

async function persistObservations(
  tx: Prisma.TransactionClient, userId: string, prices: PriceInput[], rates: FxInput[],
): Promise<void> {
  for (const price of prices) {
    const date = utcDate(price.date);
    const fetchedAt = new Date(price.fetchedAt);
    await tx.price.upsert({
      where: { userId_assetId_date_source: { userId, assetId: price.assetId, date, source: price.source } },
      create: { userId, ...price, date, fetchedAt },
      update: { close: price.close, currency: price.currency, adjustment: "RAW", fetchedAt },
    });
  }
  for (const rate of rates) {
    const date = utcDate(rate.date);
    const fetchedAt = new Date(rate.fetchedAt);
    await tx.fxRate.upsert({
      where: { userId_date_base_quote_source: { userId, date, base: rate.base, quote: rate.quote, source: rate.source } },
      create: { userId, ...rate, date, fetchedAt },
      update: { rate: rate.rate, fetchedAt },
    });
  }
}

export async function refreshMarketData(userId: string, input: unknown): Promise<JobDto> {
  const request = refreshSchema.parse(input);
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, isDemo: true } });
  if (!user) throw new AppError(404, "NOT_FOUND", "The user was not found.");
  const asset = request.assetId ? await db.asset.findFirst({ where: { id: request.assetId, userId } }) : null;
  if (request.assetId && !asset) throw new AppError(404, "ASSET_NOT_FOUND", "The selected asset was not found in this workspace.");
  const claim = await claimJob(userId, request, asset);
  if (!claim.acquired) {
    if (claim.job.status === "FAILED") throw storedJobError(claim.job);
    return marketJobDto(claim.job);
  }
  const jobId = claim.job.id;
  try {
    const context = { userId, isDemo: user.isDemo };
    const provider = createMarketDataProvider(request.provider, context, {
      beforeRequest: () => consumeProviderRequest(request.provider, userId),
    });
    const prices = asset ? await provider.getPrices({ asset, from: request.from, to: request.to }, context) : [];
    const rates = request.provider === "FRANKFURTER" ? await provider.getFx({
      from: request.from, to: request.to, base: "USD", quote: "KRW",
    }, context) : [];
    if (!prices.length && !rates.length) {
      throw new ProviderError("PROVIDER_NO_DATA", "No observations were returned for this range.", false, 422);
    }
    return await db.$transaction(async tx => {
      await lockUser(tx, userId);
      const now = new Date();
      const changed = await tx.providerJob.updateMany({
        where: {
          id: jobId, userId, status: "RUNNING",
          startedAt: { gt: new Date(now.getTime() - MARKET_JOB_TIMEOUT_MS) },
        },
        data: {
          status: "SUCCEEDED", count: prices.length + rates.length, finishedAt: now,
          message: request.provider === "FRANKFURTER"
            ? "ECB daily reference observations via Frankfurter; not executable or real-time rates."
            : "Alpha Vantage compact raw daily closes; not real-time quotes.",
          errorCode: null,
        },
      });
      if (changed.count !== 1) {
        throw new ProviderError("PROVIDER_JOB_TIMEOUT", "This refresh expired or was superseded. No observations from it were saved.", false, 409);
      }
      if (prices.length) {
        const currentAsset = await tx.asset.findFirst({ where: { id: asset!.id, userId } });
        if (!currentAsset || requestKey(userId, request, currentAsset) !== requestKey(userId, request, asset)) {
          throw new ProviderError("PROVIDER_ASSET_CHANGED", "The asset configuration changed during refresh. Retry for its current configuration.", false, 409);
        }
        await resolveOwnedPrices(tx, userId, prices.map(price => ({
          assetId: price.assetId, date: price.date, close: price.close, currency: price.currency,
        })));
      }
      await persistObservations(tx, userId, prices, rates);
      await tx.user.update({ where: { id: userId }, data: { ledgerVersion: { increment: 1 } }, select: { id: true } });
      const job = await tx.providerJob.findUniqueOrThrow({ where: { id: jobId } });
      return marketJobDto(job);
    }, { timeout: 30_000 });
  } catch (error) {
    const failure = error instanceof AppError ? error :
      new AppError(502, "PROVIDER_REFRESH_FAILED", "The refresh could not be saved. Existing observations were retained.");
    try {
      await db.providerJob.updateMany({
        where: { id: jobId, userId, status: "RUNNING" },
        data: { status: "FAILED", errorCode: failure.code, message: failure.message, finishedAt: new Date() },
      });
    } catch {
      throw new AppError(503, "PROVIDER_JOB_STATE_UNAVAILABLE", "The refresh failed and its job state could not be updated. Retry after database connectivity is restored.", {
        jobId, originalCode: failure.code,
      });
    }
    throw new AppError(failure.status, failure.code, failure.message, { jobId });
  }
}
