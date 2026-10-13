import type { AnalysisFilters, AssetInput, Currency, LedgerTransaction } from "./domain";
import type { AnalysisResult } from "./finance";

export interface AccountDto {
  id: string;
  name: string;
  institution: string;
  accountType: string;
  currency: Currency;
  portfolioId: string | null;
}
export interface PortfolioDto { id: string; name: string }
export interface AssetDto extends AssetInput { provider: string }
export interface TransactionDto extends LedgerTransaction {
  revision: number;
  source: string;
  dividendEventId: string | null;
}
export interface DividendActual {
  transactionId: string;
  assetId: string | null;
  accountId: string;
  date: string;
  currency: Currency;
  gross: string;
  tax: string;
  net: string;
  netBase: string | null;
  eventId: string | null;
}
export interface DividendUpcoming {
  id: string;
  assetId: string;
  status: "ANNOUNCED" | "ESTIMATED";
  exDate: string | null;
  recordDate: string | null;
  payDate: string | null;
  asOf: string;
  currency: Currency;
  amountPerShare: string;
  eligibleQuantity: string | null;
  expectedGross: string | null;
  expectedGrossBase: string | null;
  receivedGross: string;
  reconciled: boolean;
  source: string;
  basis: string;
  missing: string[];
}
export interface DividendAggregate {
  key: string;
  gross: string | null;
  tax: string | null;
  net: string | null;
}
export interface DividendData {
  actual: DividendActual[];
  upcoming: DividendUpcoming[];
  monthly: DividendAggregate[];
  yearly: DividendAggregate[];
  byAsset: DividendAggregate[];
}
export interface GoalDto {
  id: string;
  name: string;
  kind: "ASSET" | "DIVIDEND";
  target: string;
  currency: Currency;
  initial: string;
  monthlyContribution: string;
  annualReturn: string;
  years: number;
  actualValue: string | null;
  progress: string | null;
  projection: { year: number; value: string; contributions: string }[];
}
export interface AllocationTargetDto {
  id: string;
  dimension: string;
  key: string;
  percent: string;
}
export interface JobDto {
  id: string;
  provider: string;
  status: string;
  from: string;
  to: string;
  count: number;
  message: string | null;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
}
export interface WorkspaceData {
  user: {
    id: string;
    name: string;
    email: string;
    isDemo: boolean;
    baseCurrency: Currency;
    costMethod: "FIFO" | "AVERAGE";
    benchmarkAssetId: string | null;
    ledgerVersion: number;
  };
  filters: AnalysisFilters;
  accounts: AccountDto[];
  portfolios: PortfolioDto[];
  assets: AssetDto[];
  transactions: TransactionDto[];
  analysis: AnalysisResult;
  dividends: DividendData;
  goals: GoalDto[];
  targets: AllocationTargetDto[];
  jobs: JobDto[];
  marketData: {
    prices: { id: string; assetId: string; date: string; close: string; currency: Currency; source: string; fetchedAt: string }[];
    fx: { id: string; date: string; base: Currency; quote: Currency; rate: string; source: string; fetchedAt: string }[];
  };
  computedAt: string;
}

export const importFields = [
  "date", "kind", "symbol", "exchange", "currency", "quantity", "price", "amount",
  "fee", "tax", "toAccountId", "toCurrency", "toAmount", "ratio", "memo", "tags", "sourceTransactionId",
] as const;
export const IMPORT_FILE_LIMITS = Object.freeze({
  bytes: 2 * 1024 * 1024, rows: 2000, columns: 40, headerLength: 128, cellLength: 4096,
});
export type ImportField = (typeof importFields)[number];
export type ImportMapping = Partial<Record<ImportField, string>>;

export interface ImportUploadResult {
  jobId: string;
  filename: string;
  headers: string[];
  rows: Record<string, string>[];
  status: "UPLOADED" | "VALIDATED" | "CONFIRMED";
  duplicateFile: boolean;
  revision: number;
}
export interface ImportPreviewRow {
  rowNumber: number;
  values: Record<string, string>;
  errors: { field: string; message: string }[];
  duplicate: "NONE" | "EXACT" | "POSSIBLE";
  decision: "KEEP" | "SKIP" | "UNDECIDED";
}
export interface ImportValidationResult {
  jobId: string;
  revision: number;
  rows: ImportPreviewRow[];
  valid: boolean;
  summary: { total: number; keep: number; skip: number; errors: number };
}
