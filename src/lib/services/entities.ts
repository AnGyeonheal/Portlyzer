import { Prisma } from "@prisma/client";
import { z } from "zod";
import Decimal from "decimal.js";
import { db } from "../db";
import { AppError } from "../errors";
import { currencyInput, dateOf, decimalInput, idInput, optionalDay, positiveInput, dayInput, today } from "../input";

const name = z.string().trim().min(1).max(80);
const accountSchema = z.object({
  name,
  institution: z.string().trim().max(100).default(""),
  accountType: z.enum(["GENERAL", "ISA", "PENSION"]).default("GENERAL"),
  currency: currencyInput,
  portfolioId: idInput.nullish().transform((value) => value ?? null),
}).strict();
const portfolioSchema = z.object({ name }).strict();
const assetSchema = z.object({
  symbol: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9._:/-]+$/).transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1).max(120),
  exchange: z.string().trim().min(1).max(40).transform((value) => value.toUpperCase()),
  currency: currencyInput,
  assetClass: z.enum(["STOCK", "ETF", "CRYPTO", "CUSTOM"]),
  country: z.string().trim().max(80).nullish().transform((value) => value || null),
  sector: z.string().trim().max(80).nullish().transform((value) => value || null),
  provider: z.enum(["MANUAL", "ALPHA_VANTAGE"]).default("MANUAL"),
}).strict();

export async function userMutation<T>(userId: string, action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { ledgerVersion: { increment: 1 } } });
    return action(tx);
  }, { isolationLevel: "Serializable", timeout: 30000 });
}

function missing(): never {
  throw new AppError(404, "NOT_FOUND", "데이터를 찾을 수 없습니다.");
}

export async function saveAccount(userId: string, input: unknown, id?: string) {
  const data = accountSchema.parse(input);
  return userMutation(userId, async (tx) => {
    if (id && !await tx.brokerAccount.findFirst({ where: { id, userId } })) missing();
    if (data.portfolioId && !await tx.portfolio.findFirst({ where: { id: data.portfolioId, userId } })) missing();
    return id
      ? tx.brokerAccount.update({ where: { id, userId }, data })
      : tx.brokerAccount.create({ data: { ...data, userId } });
  });
}

export async function deleteAccount(userId: string, id: string) {
  return userMutation(userId, async (tx) => {
    if (!await tx.brokerAccount.findFirst({ where: { id, userId } })) missing();
    const records = await tx.transaction.count({ where: { userId, OR: [{ accountId: id }, { toAccountId: id }] } });
    const imports = await tx.importJob.count({ where: { userId, accountId: id } });
    if (records || imports) throw new AppError(409, "ACCOUNT_HAS_HISTORY", "거래 또는 가져오기 이력이 있는 계좌는 감사 기록 보존을 위해 삭제할 수 없습니다. 빈 계좌만 삭제할 수 있습니다.");
    return tx.brokerAccount.delete({ where: { id, userId } });
  });
}

export async function savePortfolio(userId: string, input: unknown, id?: string) {
  const data = portfolioSchema.parse(input);
  return userMutation(userId, async (tx) => {
    if (id && !await tx.portfolio.findFirst({ where: { id, userId } })) missing();
    return id ? tx.portfolio.update({ where: { id, userId }, data }) : tx.portfolio.create({ data: { ...data, userId } });
  });
}

export async function deletePortfolio(userId: string, id: string) {
  return userMutation(userId, async (tx) => {
    if (!await tx.portfolio.findFirst({ where: { id, userId } })) missing();
    return tx.portfolio.delete({ where: { id, userId } });
  });
}

export async function saveAsset(userId: string, input: unknown, id?: string) {
  const data = assetSchema.parse(input);
  if (data.provider === "ALPHA_VANTAGE" && (data.currency !== "USD" || !["NYSE", "NASDAQ", "AMEX"].includes(data.exchange) || !["STOCK", "ETF"].includes(data.assetClass))) {
    throw new AppError(422, "PROVIDER_COVERAGE", "이 제공자는 USD 미국 주식/ETF만 선택할 수 있습니다. 다른 자산은 수동 시세를 사용하세요.");
  }
  return userMutation(userId, async (tx) => {
    if (id) {
      const previous = await tx.asset.findFirst({ where: { id, userId } });
      if (!previous) missing();
      if (previous.currency !== data.currency || (previous.assetClass === "CUSTOM" && data.assetClass !== "CUSTOM")) {
        const count = await tx.transaction.count({ where: { userId, assetId: id } });
        const prices = await tx.price.count({ where: { userId, assetId: id } });
        if (count || prices) throw new AppError(409, "ASSET_HAS_HISTORY", "이력이 있는 자산의 통화 또는 사용자 정의 유형을 변경할 수 없습니다.");
      }
      return tx.asset.update({ where: { id, userId }, data });
    }
    return tx.asset.create({ data: { ...data, userId } });
  });
}

const settingsSchema = z.object({
  name: name.optional(),
  baseCurrency: currencyInput.optional(),
  costMethod: z.enum(["FIFO", "AVERAGE"]).optional(),
  benchmarkAssetId: idInput.nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "변경할 설정을 입력하세요.");

export async function saveSettings(userId: string, input: unknown) {
  const data = settingsSchema.parse(input);
  return userMutation(userId, async (tx) => {
    if (data.benchmarkAssetId && !await tx.asset.findFirst({ where: { id: data.benchmarkAssetId, userId } })) missing();
    return tx.user.update({
      where: { id: userId }, data,
      select: { id: true, name: true, baseCurrency: true, costMethod: true, benchmarkAssetId: true, ledgerVersion: true },
    });
  });
}

const goalSchema = z.object({
  name,
  kind: z.enum(["ASSET", "DIVIDEND"]),
  target: positiveInput,
  currency: currencyInput,
  initial: decimalInput,
  monthlyContribution: decimalInput,
  annualReturn: z.string().regex(/^-?(0|[1-9]\d?)(\.\d{1,8})?$/)
    .refine((value) => new Decimal(value).gt(-1) && new Decimal(value).lte(1), "가정 연수익률은 -100% 초과, 100% 이하여야 합니다."),
  years: z.number().int().min(1).max(60),
}).strict();

export async function saveGoal(userId: string, input: unknown, id?: string) {
  const data = goalSchema.parse(input);
  return userMutation(userId, async (tx) => {
    if (id && !await tx.investmentGoal.findFirst({ where: { id, userId } })) missing();
    return id ? tx.investmentGoal.update({ where: { id, userId }, data }) : tx.investmentGoal.create({ data: { ...data, userId } });
  });
}

export async function deleteGoal(userId: string, id: string) {
  return userMutation(userId, async (tx) => {
    if (!await tx.investmentGoal.findFirst({ where: { id, userId } })) missing();
    return tx.investmentGoal.delete({ where: { id, userId } });
  });
}

const dividendSchema = z.object({
  assetId: idInput,
  status: z.enum(["ANNOUNCED", "ESTIMATED"]),
  exDate: optionalDay,
  recordDate: optionalDay,
  payDate: optionalDay,
  amountPerShare: positiveInput,
  currency: currencyInput,
  source: z.string().trim().min(1).max(200),
  basis: z.string().trim().min(1).max(500),
  asOf: dayInput.refine((value) => value <= today(), "기준일은 미래일 수 없습니다."),
}).strict().refine((value) => !value.exDate || !value.payDate || value.payDate >= value.exDate, "지급일은 배당락일 이전일 수 없습니다.");

export async function saveDividend(userId: string, input: unknown, id?: string) {
  const parsed = dividendSchema.parse(input);
  return userMutation(userId, async (tx) => {
    if (id && !await tx.dividendEvent.findFirst({ where: { id, userId } })) missing();
    const asset = await tx.asset.findFirst({ where: { id: parsed.assetId, userId } });
    if (!asset) missing();
    if (asset.currency !== parsed.currency) throw new AppError(422, "CURRENCY_MISMATCH", "배당 통화는 자산 통화와 같아야 합니다.");
    const data = {
      ...parsed,
      exDate: parsed.exDate ? dateOf(parsed.exDate) : null,
      recordDate: parsed.recordDate ? dateOf(parsed.recordDate) : null,
      payDate: parsed.payDate ? dateOf(parsed.payDate) : null,
      asOf: dateOf(parsed.asOf),
    };
    if (data.exDate || data.payDate) {
      const duplicate = await tx.dividendEvent.findFirst({
        where: { userId, assetId: data.assetId, id: id ? { not: id } : undefined,
          ...(data.exDate ? { exDate: data.exDate } : { payDate: data.payDate }) },
      });
      if (duplicate) throw new AppError(409, "DIVIDEND_DUPLICATE", "같은 종목의 해당 배당 일정이 있습니다. 기존 추정 일정을 수정하여 공시 일정으로 전환하세요.");
    }
    if (id) {
      const receipts = await tx.transaction.findMany({ where: { userId, dividendEventId: id, deletedAt: null } });
      if (receipts.some((receipt) => receipt.assetId !== data.assetId || receipt.currency !== data.currency)) {
        throw new AppError(409, "DIVIDEND_HAS_RECEIPTS", "대사된 실제 수령액이 있는 일정의 자산/통화는 변경할 수 없습니다.");
      }
      return tx.dividendEvent.update({ where: { id, userId }, data });
    }
    return tx.dividendEvent.create({ data: { ...data, userId } });
  });
}

export async function deleteDividend(userId: string, id: string) {
  return userMutation(userId, async (tx) => {
    if (!await tx.dividendEvent.findFirst({ where: { id, userId } })) missing();
    if (await tx.transaction.count({ where: { userId, dividendEventId: id } })) {
      throw new AppError(409, "DIVIDEND_HAS_RECEIPTS", "수령 거래와 연결된 일정은 삭제할 수 없습니다. 거래의 연결을 먼저 해제하세요.");
    }
    return tx.dividendEvent.delete({ where: { id, userId } });
  });
}

const targetSchema = z.object({
  dimension: z.enum(["asset", "assetClass", "country", "sector", "currency", "account"]),
  key: z.string().trim().min(1).max(120),
  percent: z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/).refine((value) => new Decimal(value).lte(100), "100% 이하여야 합니다."),
}).strict();

export async function saveTarget(userId: string, input: unknown) {
  const data = targetSchema.parse(input);
  return userMutation(userId, async (tx) => {
    if (data.dimension === "account" && !await tx.brokerAccount.findFirst({ where: { id: data.key, userId } })) missing();
    if (data.dimension === "asset" && !data.key.startsWith("CASH:") && !await tx.asset.findFirst({ where: { id: data.key, userId } })) missing();
    const others = await tx.allocationTarget.findMany({ where: { userId, dimension: data.dimension, key: { not: data.key } } });
    const total = others.reduce((sum, target) => sum.plus(target.percent.toString()), new Decimal(data.percent));
    if (total.gt(100)) throw new AppError(422, "TARGET_TOTAL", "같은 분류의 목표 비중 합계는 100% 이하여야 합니다.");
    return tx.allocationTarget.upsert({
      where: { userId_dimension_key: { userId, dimension: data.dimension, key: data.key } },
      create: { userId, ...data },
      update: { percent: data.percent },
    });
  });
}

export async function deleteTarget(userId: string, id: string) {
  return userMutation(userId, async (tx) => {
    if (!await tx.allocationTarget.findFirst({ where: { id, userId } })) missing();
    return tx.allocationTarget.delete({ where: { id, userId } });
  });
}
