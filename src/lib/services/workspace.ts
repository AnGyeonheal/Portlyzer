import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../errors";
import { currencyInput, dayInput, dayOf, today } from "../input";
import { analyzePortfolio } from "../finance";
import type { AnalysisFilters, FxInput, PriceInput } from "../domain";
import type { WorkspaceData } from "../contracts";
import { transactionToDto } from "../serialization";
import { dividendInsights, goalInsights } from "./insights";

const querySchema = z.object({
  from: dayInput.optional(),
  to: dayInput.optional(),
  currency: currencyInput.optional(),
  accountId: z.string().max(100).optional(),
  portfolioId: z.string().max(100).optional(),
}).strict();

const priority = (source: string) => source === "MANUAL" ? 3 : source === "DEMO" ? 1 : 2;

export async function getWorkspace(userId: string, query: unknown): Promise<WorkspaceData> {
  const parsed = querySchema.parse(query);
  const snapshot = await db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(401, "UNAUTHORIZED", "로그인이 필요합니다.");
    const [accounts, portfolios, assets, transactions, prices, fx, events, goals, targets, jobs] = await Promise.all([
      tx.brokerAccount.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      tx.portfolio.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      tx.asset.findMany({ where: { userId }, orderBy: { symbol: "asc" } }),
      tx.transaction.findMany({ where: { userId, deletedAt: null }, include: { original: { select: { source: true } } }, orderBy: [{ date: "asc" }, { sequence: "asc" }] }),
      tx.price.findMany({ where: { userId }, orderBy: [{ date: "asc" }, { fetchedAt: "asc" }] }),
      tx.fxRate.findMany({ where: { userId }, orderBy: [{ date: "asc" }, { fetchedAt: "asc" }] }),
      tx.dividendEvent.findMany({ where: { userId } }),
      tx.investmentGoal.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      tx.allocationTarget.findMany({ where: { userId } }),
      tx.providerJob.findMany({ where: { userId }, orderBy: { startedAt: "desc" }, take: 30 }),
    ]);
    return { user, accounts, portfolios, assets, transactions, prices, fx, events, goals, targets, jobs };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30000 });
  const { user, accounts, portfolios, assets } = snapshot;
  const to = parsed.to ?? today();
  const from = parsed.from ?? `${to.slice(0, 4)}-01-01`;
  if (from > to || to > today()) throw new AppError(422, "DATE_RANGE", "기간 시작일은 종료일 이하여야 하며 실제 성과의 종료일은 미래일 수 없습니다.");
  if (parsed.accountId && parsed.accountId !== "all" && !accounts.some((account) => account.id === parsed.accountId)) {
    throw new AppError(404, "NOT_FOUND", "계좌를 찾을 수 없습니다.");
  }
  if (parsed.portfolioId && parsed.portfolioId !== "all" && !portfolios.some((portfolio) => portfolio.id === parsed.portfolioId)) {
    throw new AppError(404, "NOT_FOUND", "포트폴리오를 찾을 수 없습니다.");
  }
  const selectedAccounts = accounts.filter((account) =>
    (!parsed.accountId || parsed.accountId === "all" || account.id === parsed.accountId)
    && (!parsed.portfolioId || parsed.portfolioId === "all" || account.portfolioId === parsed.portfolioId));
  const filters: AnalysisFilters = {
    from, to, currency: parsed.currency ?? user.baseCurrency,
    accountIds: selectedAccounts.map((account) => account.id),
    costMethod: user.costMethod, benchmarkAssetId: user.benchmarkAssetId,
  };
  const transactions = snapshot.transactions.map(transactionToDto);
  const priceMap = new Map<string, PriceInput>();
  for (const row of snapshot.prices) {
    if (dayOf(row.date) > to) continue;
    if (row.adjustment !== "RAW") throw new AppError(422, "ADJUSTED_PRICE", "조정 주가는 별도 배당/분할과 중복 계산될 수 있어 지원하지 않습니다.");
    const key = `${row.assetId}:${dayOf(row.date)}`;
    const previous = priceMap.get(key);
    if (!previous || priority(row.source) >= priority(previous.source)) {
      priceMap.set(key, { assetId: row.assetId, date: dayOf(row.date), close: row.close.toString(), currency: row.currency, adjustment: "RAW", source: row.source, fetchedAt: row.fetchedAt.toISOString() });
    }
  }
  const fxMap = new Map<string, FxInput>();
  for (const row of snapshot.fx) {
    if (dayOf(row.date) > to) continue;
    const key = dayOf(row.date);
    const previous = fxMap.get(key);
    if (!previous || priority(row.source) >= priority(previous.source)) {
      fxMap.set(key, { date: key, base: row.base, quote: row.quote,
        rate: row.rate.toString(),
        source: row.source, fetchedAt: row.fetchedAt.toISOString() });
    }
  }
  const prices = [...priceMap.values()];
  const fx = [...fxMap.values()];
  const analysis = analyzePortfolio({ transactions: filters.accountIds.length ? transactions : [], assets, prices, fx, filters });
  const dividends = dividendInsights(snapshot.events, transactions, assets, fx, filters);
  const goals = goalInsights(snapshot.goals, analysis.summary.totalValue, dividends, fx, filters);
  const accountIds = new Set(filters.accountIds);
  return {
    user: {
      id: user.id, name: user.name, email: user.email, isDemo: user.isDemo,
      baseCurrency: user.baseCurrency, costMethod: user.costMethod,
      benchmarkAssetId: user.benchmarkAssetId, ledgerVersion: user.ledgerVersion,
    },
    filters, accounts, portfolios, assets, analysis, dividends, goals,
    transactions: transactions.filter((transaction) => transaction.date >= from && transaction.date <= to
      && (accountIds.has(transaction.accountId) || (!!transaction.toAccountId && accountIds.has(transaction.toAccountId)))),
    targets: snapshot.targets.map((target) => ({ ...target, percent: target.percent.toString() })),
    jobs: snapshot.jobs.map((job) => ({
      ...job, from: dayOf(job.from), to: dayOf(job.to), startedAt: job.startedAt.toISOString(), finishedAt: job.finishedAt?.toISOString() ?? null,
    })),
    marketData: {
      prices: snapshot.prices.filter((price) => dayOf(price.date) <= to).slice(-200).reverse().map((price) => ({
        id: price.id, assetId: price.assetId, date: dayOf(price.date), close: price.close.toString(), currency: price.currency, source: price.source, fetchedAt: price.fetchedAt.toISOString(),
      })),
      fx: snapshot.fx.filter((rate) => dayOf(rate.date) <= to).slice(-100).reverse().map((rate) => ({
        id: rate.id, date: dayOf(rate.date), base: rate.base, quote: rate.quote, rate: rate.rate.toString(), source: rate.source, fetchedAt: rate.fetchedAt.toISOString(),
      })),
    },
    computedAt: new Date().toISOString(),
  };
}
