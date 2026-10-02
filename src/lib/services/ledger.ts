import { randomUUID } from "node:crypto";
import { Prisma, type Asset, type BrokerAccount, type DividendEvent } from "@prisma/client";
import Decimal from "decimal.js";
import { db } from "../db";
import type { TransactionDto } from "../contracts";
import type { AssetInput, CostMethod, DataIssue, LedgerTransaction } from "../domain";
import { AppError } from "../errors";
import { validateLedger } from "../finance";
import { assetToInput, dateString, transactionToDto } from "../serialization";
import { idSchema, requestIdSchema, revisionSchema, transactionSchema, transactionUpdateSchema, type TransactionInput } from "../validation";

const D = Decimal.clone({ precision: 80 });
type TransactionRow = Prisma.TransactionGetPayload<{ include: { original: true } }>;
type Candidate = LedgerTransaction & { dividendEventId?: string | null };
interface DividendMatchChoice {
  id: string;
  assetId: string;
  currency: DividendEvent["currency"];
  status: DividendEvent["status"];
  payDate: string;
  amountPerShare: string;
}
interface LedgerIssue extends DataIssue {
  candidates?: DividendMatchChoice[];
}
export type LedgerClient = Prisma.TransactionClient;
export interface LedgerState {
  userId: string;
  costMethod: CostMethod;
  ledgerVersion: number;
  transactions: TransactionRow[];
  assets: Asset[];
  accounts: BrokerAccount[];
  dividendEvents: DividendEvent[];
}
export interface LedgerCreation {
  id?: string;
  input: TransactionInput;
  requestId?: string;
  original: {
    source: string;
    sourceKey: string;
    sourceTransactionId?: string | null;
    importJobId?: string | null;
    rowNumber?: number | null;
    rawData: Prisma.InputJsonValue;
  };
}
export type NewLedgerAsset = AssetInput & { provider?: string };
interface PlannedCreation extends LedgerCreation { id: string; sequence: number }
export interface LedgerPlan {
  creations: PlannedCreation[];
  candidates: Candidate[];
  assets: NewLedgerAsset[];
  issues: LedgerIssue[];
  entries: Prisma.JournalEntryCreateManyInput[];
}

export async function withUserLedgerLock<T>(userId: string, operation: (tx: LedgerClient) => Promise<T>): Promise<T> {
  idSchema.parse(userId);
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        const locked = await tx.user.updateMany({ where: { id: userId }, data: { ledgerVersion: { increment: 0 } } });
        if (locked.count !== 1) throw new AppError(404, "NOT_FOUND", "사용자를 찾을 수 없습니다.");
        return operation(tx);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 15_000, timeout: 90_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

export async function loadLedgerState(tx: LedgerClient, userId: string): Promise<LedgerState> {
  const [user, transactions, assets, accounts, dividendEvents] = await Promise.all([
    tx.user.findUnique({ where: { id: userId }, select: { costMethod: true, ledgerVersion: true } }),
    tx.transaction.findMany({ where: { userId }, include: { original: true }, orderBy: [{ date: "asc" }, { sequence: "asc" }, { id: "asc" }] }),
    tx.asset.findMany({ where: { userId } }),
    tx.brokerAccount.findMany({ where: { userId } }),
    tx.dividendEvent.findMany({ where: { userId } }),
  ]);
  if (!user) throw new AppError(404, "NOT_FOUND", "사용자를 찾을 수 없습니다.");
  if (transactions.some((row) => row.original.userId !== userId)) {
    throw new AppError(409, "LEDGER_OWNERSHIP", "원본 거래 소유권이 일치하지 않습니다.");
  }
  return { userId, ...user, transactions, assets, accounts, dividendEvents };
}

function referenceIssues(state: LedgerState, candidates: Candidate[], assets: AssetInput[]): DataIssue[] {
  const accounts = new Set(state.accounts.map((account) => account.id));
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const eventMap = new Map(state.dividendEvents.map((event) => [event.id, event]));
  const issues: DataIssue[] = [];
  for (const row of candidates) {
    const add = (code: string, message: string) => issues.push({
      code, message, transactionId: row.id, date: row.date, assetId: row.assetId ?? undefined, severity: "error",
    });
    if (!accounts.has(row.accountId) || (row.toAccountId && !accounts.has(row.toAccountId))) {
      add("ACCOUNT_NOT_FOUND", "본인 소유의 계좌만 사용할 수 있습니다.");
    }
    const asset = row.assetId ? assetMap.get(row.assetId) : undefined;
    if (row.assetId && !asset) add("ASSET_NOT_FOUND", "본인 소유의 종목만 사용할 수 있습니다.");
    if (asset && asset.currency !== row.currency) add("ASSET_CURRENCY", "거래 통화가 종목 통화와 일치해야 합니다.");
    if (row.kind === "VALUATION" && asset?.assetClass !== "CUSTOM") {
      add("VALUATION_ASSET", "수동 가격 평가는 사용자 정의(CUSTOM) 자산에만 사용할 수 있습니다.");
    }
    if (row.dividendEventId) {
      const event = eventMap.get(row.dividendEventId);
      if (!event) {
        add("DIVIDEND_EVENT_NOT_FOUND", "본인 소유의 배당 일정만 사용할 수 있습니다.");
      } else if (row.kind !== "DIVIDEND" || !row.assetId || event.assetId !== row.assetId || event.currency !== row.currency) {
        add("DIVIDEND_EVENT_MISMATCH", "배당 일정의 종목 및 통화가 입금 거래와 일치해야 합니다.");
      }
    }
  }
  return issues;
}

function reconcileDividend(state: LedgerState, input: TransactionInput, transactionId: string): { input: TransactionInput; issues: LedgerIssue[] } {
  if (input.kind !== "DIVIDEND" || input.dividendEventId || !input.assetId) return { input, issues: [] };
  const actualDate = new Date(`${input.date}T00:00:00.000Z`).getTime();
  const matches = state.dividendEvents.filter((event) =>
    event.assetId === input.assetId && event.currency === input.currency && event.payDate !== null &&
    Math.abs(event.payDate.getTime() - actualDate) <= 7 * 86_400_000,
  ).sort((a, b) => a.payDate!.getTime() - b.payDate!.getTime() || a.id.localeCompare(b.id));
  // Proximity is only an automatic-match rule; an explicit owned event can be chosen outside this window.
  if (matches.length === 1) return { input: { ...input, dividendEventId: matches[0].id }, issues: [] };
  if (matches.length === 0) return { input, issues: [] };
  return {
    input,
    issues: [{
      code: "DIVIDEND_MATCH_AMBIGUOUS", message: "입금일 전후 7일에 해당하는 배당 일정이 여러 개입니다. 배당 일정을 직접 선택해 주세요.",
      transactionId, assetId: input.assetId, date: input.date, severity: "error",
      candidates: matches.map((event) => ({
        id: event.id, assetId: event.assetId, currency: event.currency, status: event.status,
        payDate: dateString(event.payDate!), amountPerShare: event.amountPerShare.toFixed(),
      })),
    }],
  };
}

function activeLedger(state: LedgerState): Candidate[] {
  return state.transactions.filter((row) => !row.deletedAt).map(transactionToDto);
}

function journalEntries(userId: string, candidates: Candidate[]): { entries: Prisma.JournalEntryCreateManyInput[]; issues: DataIssue[] } {
  const entries: Prisma.JournalEntryCreateManyInput[] = [];
  const issues: DataIssue[] = [];
  const quantities = new Map<string, Decimal>();
  for (const row of [...candidates].sort((a, b) => a.date.localeCompare(b.date) || a.sequence - b.sequence || a.id.localeCompare(b.id))) {
    let line = 0;
    const amount = new D(row.amount ?? "0");
    const quantity = new D(row.quantity ?? "0");
    const fee = new D(row.fee);
    const tax = new D(row.tax);
    const charges = fee.plus(tax);
    const add = (category: string, value: Decimal, accountId = row.accountId, currency = row.currency, assetId: string | null = null, units: Decimal | null = null) => {
      const valid = [value, units].every((number) => !number || (number.isFinite() && number.abs().lessThan("100000000000000000") && number.decimalPlaces() <= 12));
      if (!valid) {
        issues.push({ code: "DECIMAL_OVERFLOW", message: "계산된 분개 금액 또는 수량이 정수 17자리·소수 12자리 한도를 초과합니다.", transactionId: row.id, date: row.date, severity: "error" });
        return;
      }
      entries.push({
        userId, transactionId: row.id, accountId, line: ++line, date: new Date(`${row.date}T00:00:00.000Z`),
        currency, category, amount: value.toFixed(), assetId, quantity: units?.toFixed() ?? null,
      });
    };
    const assetEntry = (units: Decimal, value = new D(0), accountId = row.accountId) => {
      if (!row.assetId) return;
      const key = `${accountId}\u0000${row.assetId}`;
      quantities.set(key, (quantities.get(key) ?? new D(0)).plus(units));
      add("ASSET", value, accountId, row.currency, row.assetId, units);
    };
    switch (row.kind) {
      case "BUY": {
        const notional = quantity.times(row.price ?? "0");
        add("CASH", notional.plus(charges).negated());
        assetEntry(quantity, notional);
        break;
      }
      case "SELL": {
        const notional = quantity.times(row.price ?? "0");
        add("CASH", notional.minus(charges));
        assetEntry(quantity.negated(), notional.negated());
        break;
      }
      case "DEPOSIT":
        add("CASH", amount.minus(charges));
        add("FLOW", amount.negated());
        break;
      case "WITHDRAWAL":
        add("CASH", amount.plus(charges).negated());
        add("FLOW", amount);
        break;
      case "DIVIDEND":
      case "INTEREST":
        add("CASH", amount.minus(charges));
        add("INCOME", amount.negated());
        break;
      case "FEE":
      case "TAX":
        add("CASH", amount.negated());
        add(row.kind, amount);
        break;
      case "FX":
        add("CASH", amount.plus(charges).negated());
        add("FX", amount);
        add("CASH", new D(row.toAmount ?? "0"), row.accountId, row.toCurrency!);
        add("FX", new D(row.toAmount ?? "0").negated(), row.accountId, row.toCurrency!);
        break;
      case "TRANSFER":
        if (row.assetId) {
          assetEntry(quantity.negated());
          assetEntry(quantity, new D(0), row.toAccountId!);
          if (!charges.isZero()) add("CASH", charges.negated());
        } else {
          add("CASH", amount.plus(charges).negated());
          add("CASH", amount, row.toAccountId!);
        }
        break;
      case "SPLIT": {
        const held = quantities.get(`${row.accountId}\u0000${row.assetId}`) ?? new D(0);
        assetEntry(held.times(row.ratio ?? "1").minus(held));
        break;
      }
      case "VALUATION":
        add("VALUATION", new D(0), row.accountId, row.currency, row.assetId ?? null);
        break;
    }
    if (!fee.isZero()) add("FEE", fee);
    if (!tax.isZero()) add("TAX", tax);
  }
  return { entries, issues };
}

function inspectLedger(state: LedgerState, candidates: Candidate[], newAssets: NewLedgerAsset[] = []) {
  const assets = [...state.assets.map(assetToInput), ...newAssets];
  const ownership = referenceIssues(state, candidates, assets);
  if (ownership.length) return { issues: ownership, entries: [] as Prisma.JournalEntryCreateManyInput[] };
  const issues = validateLedger(candidates, assets, state.costMethod);
  if (issues.some((issue) => issue.severity === "error")) return { issues, entries: [] as Prisma.JournalEntryCreateManyInput[] };
  const journals = journalEntries(state.userId, candidates);
  return { issues: [...issues, ...journals.issues], entries: journals.entries };
}

function assertValid(issues: LedgerIssue[]): void {
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length) {
    const missing = errors.some((issue) => ["ACCOUNT_NOT_FOUND", "ASSET_NOT_FOUND", "DIVIDEND_EVENT_NOT_FOUND"].includes(issue.code));
    const ambiguous = errors.find((issue) => issue.code === "DIVIDEND_MATCH_AMBIGUOUS");
    if (!missing && ambiguous) {
      throw new AppError(422, "DIVIDEND_MATCH_AMBIGUOUS", ambiguous.message, {
        field: "dividendEventId", transactionId: ambiguous.transactionId, assetId: ambiguous.assetId, date: ambiguous.date,
        candidates: ambiguous.candidates, issues: errors,
      });
    }
    throw new AppError(missing ? 404 : 422, missing ? "NOT_FOUND" : "INVALID_LEDGER",
      missing ? "참조한 계좌, 종목 또는 배당 일정을 찾을 수 없습니다." : "거래 변경으로 잔액 부족, 초과 매도 또는 잘못된 원장이 발생합니다.", { issues: errors });
  }
}

export function planLedgerBatch(state: LedgerState, creations: LedgerCreation[], assets: NewLedgerAsset[] = []): LedgerPlan {
  let sequence = state.transactions.reduce((max, row) => Math.max(max, row.sequence), 0);
  const matchingIssues: LedgerIssue[] = [];
  const planned = creations.map((creation) => {
    const id = creation.id ?? randomUUID();
    const matched = reconcileDividend(state, transactionSchema.parse(creation.input), id);
    matchingIssues.push(...matched.issues);
    return { ...creation, input: matched.input, id, sequence: ++sequence };
  });
  if (sequence > 2_147_483_647) throw new AppError(422, "LEDGER_LIMIT", "거래 순서 한도를 초과했습니다.");
  const candidates = [...activeLedger(state), ...planned.map((creation) => ({ ...creation.input, id: creation.id, sequence: creation.sequence }))];
  const inspected = inspectLedger(state, candidates, assets);
  return { creations: planned, assets, candidates, entries: inspected.entries, issues: [...matchingIssues, ...inspected.issues] };
}

function transactionData(input: TransactionInput) {
  return { ...input, date: new Date(`${input.date}T00:00:00.000Z`) };
}

function snapshot(row: TransactionDto, deletedAt: string | null = null): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify({ ...row, deletedAt })) as Prisma.InputJsonObject;
}

async function rebuildDerived(tx: LedgerClient, state: LedgerState, candidates: Candidate[], entries: Prisma.JournalEntryCreateManyInput[], sources: Map<string, string>): Promise<void> {
  await tx.journalEntry.deleteMany({ where: { userId: state.userId } });
  for (let offset = 0; offset < entries.length; offset += 500) {
    await tx.journalEntry.createMany({ data: entries.slice(offset, offset + 500) });
  }
  await tx.corporateAction.deleteMany({ where: { userId: state.userId } });
  const actions = candidates.filter((row) => row.kind === "SPLIT").map((row) => ({
    userId: state.userId, transactionId: row.id, assetId: row.assetId!, date: new Date(`${row.date}T00:00:00.000Z`),
    kind: "SPLIT", ratio: row.ratio!, source: sources.get(row.id)!,
  }));
  if (actions.length) await tx.corporateAction.createMany({ data: actions });
  await tx.user.update({ where: { id: state.userId }, data: { ledgerVersion: { increment: 1 } } });
}

export async function createLedgerBatch(tx: LedgerClient, state: LedgerState, creations: LedgerCreation[], assets: NewLedgerAsset[] = []): Promise<TransactionDto[]> {
  const plan = planLedgerBatch(state, creations, assets);
  assertValid(plan.issues);
  if (!plan.creations.length) return [];
  const originalIds = new Map(plan.creations.map((creation) => [creation.id, randomUUID()]));
  if (assets.length) {
    await tx.asset.createMany({ data: assets.map((asset) => ({ ...asset, userId: state.userId, provider: asset.provider ?? "MANUAL" })) });
  }
  for (let offset = 0; offset < plan.creations.length; offset += 250) {
    const chunk = plan.creations.slice(offset, offset + 250);
    await tx.originalTransaction.createMany({ data: chunk.map((creation) => ({
      ...creation.original, id: originalIds.get(creation.id)!, userId: state.userId,
    })) });
    await tx.transaction.createMany({ data: chunk.map((creation) => ({
      ...transactionData(creation.input), id: creation.id, userId: state.userId,
      originalId: originalIds.get(creation.id)!, sequence: creation.sequence, requestId: creation.requestId ?? null,
    })) });
    await tx.transactionRevision.createMany({ data: chunk.map((creation) => ({
      userId: state.userId, transactionId: creation.id, version: 1, operation: "CREATE", before: Prisma.DbNull,
      after: snapshot({ ...creation.input, id: creation.id, sequence: creation.sequence, revision: 1, source: creation.original.source }),
    })) });
  }
  const sources = new Map(state.transactions.map((row) => [row.id, row.original.source]));
  for (const creation of plan.creations) sources.set(creation.id, creation.original.source);
  await rebuildDerived(tx, state, plan.candidates, plan.entries, sources);
  const result = await tx.transaction.findMany({
    where: { userId: state.userId, id: { in: plan.creations.map((creation) => creation.id) } },
    include: { original: true }, orderBy: [{ sequence: "asc" }, { id: "asc" }],
  });
  return result.map(transactionToDto);
}

export async function createTransaction(userId: string, input: unknown, requestId?: string): Promise<TransactionDto> {
  const value = transactionSchema.parse(input);
  const key = requestId === undefined ? undefined : requestIdSchema.parse(requestId);
  return withUserLedgerLock(userId, async (tx) => {
    const state = await loadLedgerState(tx, userId);
    if (key) {
      const previous = state.transactions.find((row) => row.requestId === key);
      if (previous) {
        const raw = transactionSchema.safeParse(previous.original.rawData);
        if (previous.deletedAt || !raw.success || JSON.stringify(raw.data) !== JSON.stringify(value)) {
          throw new AppError(409, "IDEMPOTENCY_CONFLICT", "이미 다른 요청 또는 삭제된 거래에 사용한 요청 ID입니다.");
        }
        return transactionToDto(previous);
      }
    }
    const [created] = await createLedgerBatch(tx, state, [{
      input: value, requestId: key,
      original: { source: "MANUAL", sourceKey: `manual:${randomUUID()}`, rawData: JSON.parse(JSON.stringify(input)) as Prisma.InputJsonValue },
    }]);
    return created;
  });
}

export async function updateTransaction(userId: string, id: string, input: unknown): Promise<TransactionDto> {
  idSchema.parse(id);
  const { revision, ...value } = transactionUpdateSchema.parse(input);
  return withUserLedgerLock(userId, async (tx) => {
    const state = await loadLedgerState(tx, userId);
    const previous = state.transactions.find((row) => row.id === id && !row.deletedAt);
    if (!previous) throw new AppError(404, "NOT_FOUND", "거래를 찾을 수 없습니다.");
    if (previous.revision !== revision) throw new AppError(409, "REVISION_CONFLICT", "거래가 변경되었습니다. 새로고침 후 다시 시도해 주세요.");
    const matched = reconcileDividend(state, value, id);
    const candidates = activeLedger(state).map((row) => row.id === id ? { ...matched.input, id, sequence: previous.sequence } : row);
    const inspected = inspectLedger(state, candidates);
    assertValid([...matched.issues, ...inspected.issues]);
    const updated = await tx.transaction.updateMany({
      where: { id, userId, revision, deletedAt: null }, data: { ...transactionData(matched.input), revision: { increment: 1 } },
    });
    if (updated.count !== 1) throw new AppError(409, "REVISION_CONFLICT", "거래가 동시에 변경되었습니다.");
    const result = await tx.transaction.findFirst({ where: { id, userId }, include: { original: true } });
    if (!result) throw new AppError(404, "NOT_FOUND", "거래를 찾을 수 없습니다.");
    await tx.transactionRevision.create({ data: {
      userId, transactionId: id, version: revision + 1, operation: "UPDATE",
      before: snapshot(transactionToDto(previous)), after: snapshot(transactionToDto(result)),
    } });
    await rebuildDerived(tx, state, candidates, inspected.entries, new Map(state.transactions.map((row) => [row.id, row.original.source])));
    return transactionToDto(result);
  });
}

export async function deleteTransaction(userId: string, id: string, revision: number): Promise<void> {
  idSchema.parse(id);
  revisionSchema.parse(revision);
  await withUserLedgerLock(userId, async (tx) => {
    const state = await loadLedgerState(tx, userId);
    const previous = state.transactions.find((row) => row.id === id && !row.deletedAt);
    if (!previous) throw new AppError(404, "NOT_FOUND", "거래를 찾을 수 없습니다.");
    if (previous.revision !== revision) throw new AppError(409, "REVISION_CONFLICT", "거래가 변경되었습니다. 새로고침 후 다시 시도해 주세요.");
    const candidates = activeLedger(state).filter((row) => row.id !== id);
    const inspected = inspectLedger(state, candidates);
    assertValid(inspected.issues);
    const deletedAt = new Date();
    const updated = await tx.transaction.updateMany({
      where: { id, userId, revision, deletedAt: null }, data: { deletedAt, revision: { increment: 1 } },
    });
    if (updated.count !== 1) throw new AppError(409, "REVISION_CONFLICT", "거래가 동시에 변경되었습니다.");
    await tx.transactionRevision.create({ data: {
      userId, transactionId: id, version: revision + 1, operation: "DELETE",
      before: snapshot(transactionToDto(previous)),
      after: snapshot({ ...transactionToDto(previous), revision: revision + 1 }, deletedAt.toISOString()),
    } });
    await rebuildDerived(tx, state, candidates, inspected.entries, new Map(state.transactions.map((row) => [row.id, row.original.source])));
  });
}

export async function getTransactionHistory(userId: string, id: string) {
  idSchema.parse(userId);
  idSchema.parse(id);
  const row = await db.transaction.findFirst({
    where: { id, userId }, include: { original: true, revisions: { where: { userId }, orderBy: { version: "asc" } } },
  });
  if (!row || row.original.userId !== userId) throw new AppError(404, "NOT_FOUND", "거래를 찾을 수 없습니다.");
  return { transaction: { ...transactionToDto(row), deletedAt: row.deletedAt?.toISOString() ?? null }, original: row.original, revisions: row.revisions };
}
