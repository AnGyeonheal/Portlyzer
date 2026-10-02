import type { Asset, Transaction } from "@prisma/client";
import type { TransactionDto } from "./contracts";
import type { AssetInput, LedgerTransaction } from "./domain";

export function dateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function transactionToLedger(row: Transaction): LedgerTransaction {
  return {
    id: row.id,
    accountId: row.accountId,
    date: dateString(row.date),
    sequence: row.sequence,
    kind: row.kind,
    currency: row.currency,
    assetId: row.assetId,
    quantity: row.quantity?.toFixed() ?? null,
    price: row.price?.toFixed() ?? null,
    amount: row.amount?.toFixed() ?? null,
    fee: row.fee.toFixed(),
    tax: row.tax.toFixed(),
    toAccountId: row.toAccountId,
    toCurrency: row.toCurrency,
    toAmount: row.toAmount?.toFixed() ?? null,
    ratio: row.ratio?.toFixed() ?? null,
    memo: row.memo,
    tags: [...row.tags],
  };
}

export function transactionToDto(row: Transaction & { original: { source: string } }): TransactionDto {
  return {
    ...transactionToLedger(row),
    revision: row.revision,
    source: row.original.source,
    dividendEventId: row.dividendEventId,
  };
}

export function assetToInput(row: Asset): AssetInput {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange,
    currency: row.currency,
    assetClass: row.assetClass,
    country: row.country,
    sector: row.sector,
  };
}
