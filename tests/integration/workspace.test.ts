import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { saveAccount, saveAsset, saveDividend, saveGoal, savePortfolio, saveSettings, saveTarget } from "@/lib/services/entities";
import { createTransaction, deleteTransaction, getTransactionHistory, updateTransaction } from "@/lib/services/ledger";
import { importManualPrices, upsertManualFx } from "@/lib/services/market";
import { getWorkspace } from "@/lib/services/workspace";
import type { TransactionDto } from "@/lib/contracts";

const suite = process.env.RUN_INTEGRATION === "1" ? describe : describe.skip;

suite("persistent whole-workspace integration", () => {
  const userId = randomUUID();
  const otherId = randomUUID();
  const fxUserId = randomUUID();
  let accountId: string;
  let targetAccountId: string;
  let assetId: string;
  let dividend: TransactionDto;
  let purchase: TransactionDto;
  let sale: TransactionDto;
  const filters = { from: "2025-01-02", to: "2025-01-04", currency: "USD" };

  beforeAll(async () => {
    await db.user.createMany({ data: [
      { id: userId, name: "Workspace fixture", email: `${userId}@example.invalid`, baseCurrency: "USD" },
      { id: otherId, name: "Isolation fixture", email: `${otherId}@example.invalid` },
      { id: fxUserId, name: "FX precision fixture", email: `${fxUserId}@example.invalid` },
    ] });
    const portfolio = await savePortfolio(userId, { name: "Fixture portfolio" });
    accountId = (await saveAccount(userId, { name: "Source", currency: "USD", portfolioId: portfolio.id })).id;
    targetAccountId = (await saveAccount(userId, { name: "Target", currency: "USD" })).id;
    assetId = (await saveAsset(userId, { symbol: "FIX", name: "Fixture stock", exchange: "NASDAQ", currency: "USD", assetClass: "STOCK" })).id;
    await createTransaction(userId, { accountId, date: "2025-01-02", kind: "DEPOSIT", currency: "USD", amount: "1000" });
    purchase = await createTransaction(userId, { accountId, date: "2025-01-02", kind: "BUY", assetId, currency: "USD", quantity: "10", price: "10", fee: "2" });
    sale = await createTransaction(userId, { accountId, date: "2025-01-03", kind: "SELL", assetId, currency: "USD", quantity: "4", price: "15", fee: "1" });
    const event = await saveDividend(userId, { assetId, currency: "USD", status: "ANNOUNCED", exDate: "2025-01-03", payDate: "2025-01-03", amountPerShare: "1", source: "Fixture announcement", basis: "Manual independent example", asOf: "2025-01-02" });
    dividend = await createTransaction(userId, { accountId, date: "2025-01-03", kind: "DIVIDEND", assetId, currency: "USD", amount: "10", tax: "2", dividendEventId: event.id });
    await createTransaction(userId, { accountId, date: "2025-01-03", kind: "TRANSFER", currency: "USD", amount: "100", toAccountId: targetAccountId });
    await createTransaction(userId, { accountId, date: "2025-01-04", kind: "TRANSFER", currency: "USD", assetId, quantity: "2", toAccountId: targetAccountId });
    await importManualPrices(userId, { rows: [
      { assetId, date: "2025-01-02", currency: "USD", close: "10" },
      { assetId, date: "2025-01-03", currency: "USD", close: "12" },
      { assetId, date: "2025-01-04", currency: "USD", close: "14" },
    ] });
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { id: { in: [userId, otherId, fxUserId] } } });
    await db.$disconnect();
  });

  it("reconciles cash, FIFO partial sales, actual dividends and consolidated transfers", async () => {
    const workspace = await getWorkspace(userId, filters);
    // 1000 - (100+2) + (60-1) + (10-2) + 6*14 = 1049.
    expect(workspace.analysis.summary.totalValue).toBe("1049");
    expect(workspace.analysis.summary.netContributions).toBe("1000");
    expect(workspace.analysis.summary.totalPnl).toBe("49");
    expect(workspace.analysis.positions.reduce((sum, row) => sum + Number(row.quantity), 0)).toBe(6);
    expect(workspace.dividends.actual[0].net).toBe("8");
    expect(workspace.dividends.upcoming[0].eligibleQuantity).toBe("10");
    expect(workspace.dividends.upcoming[0].expectedGross).toBe("0");
    expect(workspace.dividends.upcoming[0].reconciled).toBe(true);
    const source = await getWorkspace(userId, { ...filters, accountId });
    expect(source.analysis.summary.totalValue).toBe("921");
    expect(source.analysis.positions[0].quantity).toBe("4");
  });

  it("applies actual goal progress and limits allocation totals", async () => {
    await saveGoal(userId, { name: "Asset target", kind: "ASSET", target: "2000", currency: "USD", initial: "1000", monthlyContribution: "100", annualReturn: "0", years: 1 });
    const workspace = await getWorkspace(userId, filters);
    expect(workspace.goals[0].actualValue).toBe("1049");
    expect(workspace.goals[0].progress).toBe("0.5245");
    expect(workspace.goals[0].projection.at(-1)?.value).toBe("2200");
    await saveTarget(userId, { dimension: "assetClass", key: "STOCK", percent: "70" });
    await expect(saveTarget(userId, { dimension: "assetClass", key: "ETF", percent: "40" })).rejects.toMatchObject({ code: "TARGET_TOTAL" });
  });

  it("keeps an empty portfolio empty rather than treating its empty selection as all accounts", async () => {
    const empty = await savePortfolio(userId, { name: "Empty selection" });
    const data = await getWorkspace(userId, { ...filters, portfolioId: empty.id });
    expect(data.filters.accountIds).toEqual([]);
    expect(data.transactions).toEqual([]);
    expect(data.analysis.positions).toEqual([]);
    expect(data.analysis.cash).toEqual([]);
    expect(data.analysis.summary.totalValue).toBe("0");
    expect(data.analysis.summary.netContributions).toBe("0");
  });

  it("preserves original inverse-rate precision and manual precedence across quote orientations", async () => {
    const account = await saveAccount(fxUserId, { name: "Exact conversion", currency: "USD" });
    await createTransaction(fxUserId, { accountId: account.id, date: "2025-01-02", kind: "DEPOSIT", currency: "USD", amount: "3" });
    await upsertManualFx(fxUserId, { date: "2025-01-02", base: "KRW", quote: "USD", rate: "0.00075" });
    await db.fxRate.updateMany({ where: { userId: fxUserId }, data: { fetchedAt: new Date("2025-01-02T10:00:00Z") } });
    await db.fxRate.create({ data: {
      userId: fxUserId, date: new Date("2025-01-02"), base: "USD", quote: "KRW", rate: "1",
      source: "TEST_FIXTURE", fetchedAt: new Date("2025-01-03T10:00:00Z"),
    } });
    const data = await getWorkspace(fxUserId, { from: "2025-01-02", to: "2025-01-02", currency: "KRW" });
    // 3 / 0.00075 = 4000, with no rounded reciprocal intermediate.
    expect(data.analysis.summary.totalValue).toBe("4000");
    expect(data.analysis.summary.netContributions).toBe("4000");
    expect(data.analysis.provenance.some((entry) => entry.source === "MANUAL" && entry.inverted)).toBe(true);
  });

  it("rejects all cross-user references instead of leaking records", async () => {
    await expect(getWorkspace(otherId, { ...filters, accountId })).rejects.toMatchObject({ status: 404 });
    await expect(saveSettings(otherId, { benchmarkAssetId: assetId })).rejects.toMatchObject({ status: 404 });
    await expect(getTransactionHistory(otherId, sale.id)).rejects.toMatchObject({ status: 404 });
    await expect(saveAccount(otherId, { name: "Hijack", currency: "USD" }, accountId)).rejects.toMatchObject({ status: 404 });
    const other = await getWorkspace(otherId, filters);
    expect(other.transactions).toHaveLength(0);
    expect(other.assets).toHaveLength(0);
  });

  it("replays all subsequent balances after edits and deletion without changing originals", async () => {
    const changed = await updateTransaction(userId, sale.id, {
      accountId, date: "2025-01-03", kind: "SELL", assetId, currency: "USD", quantity: "5", price: "15", fee: "1", revision: sale.revision,
    });
    expect(changed.revision).toBe(sale.revision + 1);
    let workspace = await getWorkspace(userId, filters);
    // One extra share sold for 15 and one fewer share marked at 14.
    expect(workspace.analysis.summary.totalValue).toBe("1050");
    await deleteTransaction(userId, dividend.id, dividend.revision);
    workspace = await getWorkspace(userId, filters);
    expect(workspace.analysis.summary.totalValue).toBe("1042");
    expect(workspace.dividends.actual).toHaveLength(0);
    expect(workspace.dividends.upcoming[0].expectedGross).toBe("10");
    const history = await getTransactionHistory(userId, sale.id);
    expect(JSON.stringify(history)).toContain('"quantity":"4"');
    await expect(deleteTransaction(userId, purchase.id, purchase.revision)).rejects.toMatchObject({ status: 422 });
  });
});
