export type Currency = "KRW" | "USD";
export type CostMethod = "FIFO" | "AVERAGE";
export type AssetClass = "STOCK" | "ETF" | "CRYPTO" | "CUSTOM";
export type TransactionKind =
  | "BUY" | "SELL" | "DEPOSIT" | "WITHDRAWAL" | "DIVIDEND" | "INTEREST"
  | "FEE" | "TAX" | "FX" | "TRANSFER" | "SPLIT" | "VALUATION";

export interface AssetInput {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  currency: Currency;
  assetClass: AssetClass;
  country: string | null;
  sector: string | null;
}

export interface LedgerTransaction {
  id: string;
  accountId: string;
  date: string;
  sequence: number;
  kind: TransactionKind;
  currency: Currency;
  assetId?: string | null;
  quantity?: string | null;
  price?: string | null;
  amount?: string | null;
  fee: string;
  tax: string;
  toAccountId?: string | null;
  toCurrency?: Currency | null;
  toAmount?: string | null;
  ratio?: string | null;
  memo: string;
  tags: string[];
}

export interface PriceInput {
  assetId: string;
  date: string;
  close: string;
  currency: Currency;
  source: string;
  fetchedAt: string;
  adjustment: "RAW";
}

export interface FxInput {
  date: string;
  base: Currency;
  quote: Currency;
  rate: string;
  source: string;
  fetchedAt: string;
}

export interface AnalysisFilters {
  from: string;
  to: string;
  currency: Currency;
  accountIds: string[];
  costMethod: CostMethod;
  benchmarkAssetId?: string | null;
}

export interface DataIssue {
  code: string;
  message: string;
  date?: string;
  transactionId?: string;
  assetId?: string;
  severity: "error" | "warning";
}
