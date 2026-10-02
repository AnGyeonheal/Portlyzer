import Decimal from "decimal.js";
import { db } from "../db";
import { AppError } from "../errors";
import { dateOf, shiftDay, today } from "../input";
import { createTransaction } from "./ledger";

export async function seedDemoUser(userId: string) {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user?.isDemo) throw new AppError(403, "DEMO_ISOLATION", "데모 데이터는 별도 데모 사용자에게만 생성할 수 있습니다.");
  if (await db.transaction.count({ where: { userId } })) return { alreadySeeded: true };
  if (await db.brokerAccount.count({ where: { userId } })) throw new AppError(409, "DEMO_INCOMPLETE", "초기화가 완료되지 않은 데모입니다. 새 데모 세션을 사용하세요.");
  const end = today();
  const start = shiftDay(end, -180);
  const setup = await db.$transaction(async (tx) => {
    const growth = await tx.portfolio.create({ data: { userId, name: "장기 성장" } });
    const income = await tx.portfolio.create({ data: { userId, name: "배당과 연금" } });
    const kr = await tx.brokerAccount.create({ data: { userId, name: "국내 주식", institution: "예제 증권사", accountType: "ISA", currency: "KRW", portfolioId: income.id } });
    const us = await tx.brokerAccount.create({ data: { userId, name: "글로벌 투자", institution: "예제 브로커", accountType: "GENERAL", currency: "USD", portfolioId: growth.id } });
    const samsung = await tx.asset.create({ data: { userId, symbol: "005930", name: "삼성전자", exchange: "KRX", currency: "KRW", assetClass: "STOCK", country: "대한민국", sector: "기술", provider: "MANUAL" } });
    const apple = await tx.asset.create({ data: { userId, symbol: "AAPL", name: "Apple", exchange: "NASDAQ", currency: "USD", assetClass: "STOCK", country: "미국", sector: "기술", provider: "MANUAL" } });
    const voo = await tx.asset.create({ data: { userId, symbol: "VOO", name: "Vanguard S&P 500 ETF", exchange: "NYSE", currency: "USD", assetClass: "ETF", country: "미국", sector: "시장 지수", provider: "MANUAL" } });
    const bitcoin = await tx.asset.create({ data: { userId, symbol: "BTC", name: "Bitcoin", exchange: "CUSTOM", currency: "USD", assetClass: "CRYPTO", provider: "MANUAL" } });
    const assets = [{ asset: samsung, base: "70000" }, { asset: apple, base: "190" }, { asset: voo, base: "500" }, { asset: bitcoin, base: "50000" }];
    const prices = [];
    const rates = [];
    for (let index = 0; index <= 180; index++) {
      const date = dateOf(shiftDay(start, index));
      for (const { asset, base } of assets) {
        const growthRate = new Decimal(index).div(1200);
        const fluctuation = new Decimal((index * 7) % 23 - 11).div(1000);
        prices.push({
          userId, assetId: asset.id, date, currency: asset.currency,
          close: new Decimal(base).mul(new Decimal(1).plus(growthRate).plus(fluctuation)).toFixed(8),
          source: "DEMO", adjustment: "RAW",
        });
      }
      rates.push({ userId, date, base: "USD" as const, quote: "KRW" as const, rate: new Decimal(1320).plus(index % 21).toString(), source: "DEMO" });
    }
    await tx.price.createMany({ data: prices });
    await tx.fxRate.createMany({ data: rates });
    await tx.user.update({ where: { id: userId }, data: { benchmarkAssetId: voo.id, ledgerVersion: { increment: 1 } } });
    await tx.investmentGoal.createMany({ data: [
      { userId, name: "첫 1억 만들기", kind: "ASSET", target: "100000000", currency: "KRW", initial: "40000000", monthlyContribution: "1000000", annualReturn: "0.06", years: 5 },
      { userId, name: "월 배당 생활비", kind: "DIVIDEND", target: "300000", currency: "KRW", initial: "0", monthlyContribution: "500000", annualReturn: "0.04", years: 10 },
    ] });
    await tx.allocationTarget.createMany({ data: [
      { userId, dimension: "assetClass", key: "STOCK", percent: "35" },
      { userId, dimension: "assetClass", key: "ETF", percent: "35" },
      { userId, dimension: "assetClass", key: "CRYPTO", percent: "5" },
      { userId, dimension: "assetClass", key: "CASH", percent: "25" },
    ] });
    await tx.dividendEvent.createMany({ data: [
      { userId, assetId: voo.id, status: "ANNOUNCED", exDate: dateOf(shiftDay(end, 12)), recordDate: dateOf(shiftDay(end, 13)), payDate: dateOf(shiftDay(end, 19)), amountPerShare: "1.8", currency: "USD", source: "DEMO", basis: "데모 전용 공시 예시입니다. 실제 공시가 아닙니다.", asOf: dateOf(end) },
      { userId, assetId: samsung.id, status: "ESTIMATED", exDate: dateOf(shiftDay(end, 30)), payDate: null, amountPerShare: "361", currency: "KRW", source: "DEMO", basis: "데모 전용 과거 배당 가정. 지급일 미확인.", asOf: dateOf(end) },
    ] });
    return { kr, us, samsung, apple, voo, bitcoin };
  });
  const { kr, us, samsung, apple, voo, bitcoin } = setup;
  const transaction = (day: number, values: Record<string, unknown>) => ({
    accountId: us.id, date: shiftDay(start, day), currency: "USD", fee: "0", tax: "0", memo: "데모 예시 거래", tags: ["데모"], ...values,
  });
  const transactions = [
    transaction(0, { accountId: kr.id, currency: "KRW", kind: "DEPOSIT", amount: "12000000" }),
    transaction(0, { kind: "DEPOSIT", amount: "20000" }),
    transaction(1, { accountId: kr.id, currency: "KRW", kind: "BUY", assetId: samsung.id, quantity: "50", price: "70000", fee: "1500" }),
    transaction(1, { kind: "BUY", assetId: apple.id, quantity: "10", price: "190", fee: "1" }),
    transaction(2, { kind: "BUY", assetId: voo.id, quantity: "15", price: "500", fee: "1" }),
    transaction(3, { kind: "BUY", assetId: bitcoin.id, quantity: "0.05", price: "50000", fee: "1" }),
    transaction(35, { kind: "DIVIDEND", assetId: voo.id, amount: "25.50", tax: "3.825" }),
    transaction(45, { accountId: kr.id, currency: "KRW", kind: "FX", amount: "1000000", toCurrency: "USD", toAmount: "750", fee: "2000" }),
    transaction(50, { kind: "TRANSFER", amount: "1000", toAccountId: kr.id }),
    transaction(70, { accountId: kr.id, currency: "KRW", kind: "DIVIDEND", assetId: samsung.id, amount: "18050", tax: "2779.7" }),
    transaction(90, { kind: "SELL", assetId: apple.id, quantity: "4", price: "210", fee: "1", memo: "비중 조정에 따른 일부 매도", tags: ["데모", "리밸런싱"] }),
    transaction(100, { kind: "DIVIDEND", assetId: voo.id, amount: "27", tax: "4.05" }),
    transaction(120, { kind: "INTEREST", amount: "12.50", tax: "1.875" }),
    transaction(135, { kind: "TRANSFER", assetId: voo.id, quantity: "2", toAccountId: kr.id }),
    transaction(150, { kind: "FEE", amount: "5" }),
    transaction(170, { kind: "DIVIDEND", assetId: apple.id, amount: "1.50", tax: "0.225" }),
  ];
  for (const [index, input] of transactions.entries()) {
    await createTransaction(userId, input, `demo-${userId}-${index}`);
  }
  return { alreadySeeded: false };
}
