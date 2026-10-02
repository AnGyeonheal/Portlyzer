import type {
  AnalysisFilters,
  AssetInput,
  Currency,
  DataIssue,
  FxInput,
  LedgerTransaction,
  PriceInput,
} from "../domain";

export type {
  AnalysisFilters, AssetInput, AssetClass, CostMethod, Currency, DataIssue,
  FxInput, LedgerTransaction, PriceInput, TransactionKind,
} from "../domain";

export type Amount = string | null;

export interface AnalysisInput {
  transactions: LedgerTransaction[];
  assets: AssetInput[];
  prices: PriceInput[];
  fx: FxInput[];
  filters: AnalysisFilters;
}

export type XirrStatus =
  | "CONVERGED"
  | "MULTIPLE_ROOTS"
  | "NO_SOLUTION"
  | "NON_CONVERGENT"
  | "MISSING_DATA"
  | "INVALID_INPUT";

export interface XirrResult {
  /** Annual effective rate, not the holding-period return. */
  value: Amount;
  annualized: Amount;
  cumulative: Amount;
  status: XirrStatus;
  roots: string[];
  iterations: number;
  days: number;
  message: string;
  searchBounds: { minLogGrowth: string; maxLogGrowth: string };
}

export interface XirrCashFlow {
  date: string;
  /** Investor perspective: investment negative, receipt positive. */
  amount: string;
}

export interface XirrOptions {
  maxIterations?: number;
  minLogGrowth?: number;
  maxLogGrowth?: number;
}

export interface PortfolioSummary {
  totalValue: Amount;
  costBasis: Amount;
  realizedPnl: Amount;
  unrealizedPnl: Amount;
  totalPnl: Amount;
  netContributions: Amount;
  dividends: Amount;
  grossDividends: Amount;
  interest: Amount;
  fees: Amount;
  taxes: Amount;
  simpleReturn: Amount;
  simpleReturnCapital: Amount;
  twr: Amount;
  twrAnnualized: Amount;
  mwr: XirrResult;
  /** Negative drawdown, e.g. "-0.2" means a 20% decline. */
  mdd: Amount;
  openingValue: Amount;
  periodNetContributions: Amount;
  cumulativePnl: Amount;
}

export interface HistoryPoint {
  date: string;
  value: Amount;
  netContributions: Amount;
  externalFlow: Amount;
  profit: Amount;
  twr: Amount;
  portfolioPriceTwr: Amount;
  dailyReturn: Amount;
  drawdown: Amount;
  benchmarkValue: Amount;
  benchmarkReturn: Amount;
}

export interface PositionResult {
  accountId: string;
  assetId: string;
  quantity: string;
  averageCost: Amount;
  costBasis: Amount;
  costBasisBase: Amount;
  value: Amount;
  valueBase: Amount;
  unrealizedPnl: Amount;
  unrealizedPnlBase: Amount;
  realizedPnlBase: Amount;
  dividendsBase: Amount;
  weight: Amount;
}

export interface CashResult {
  accountId: string;
  currency: Currency;
  balance: string;
  valueBase: Amount;
}

export interface HistoricalQuantity {
  accountId: string;
  assetId: string;
  quantity: string;
}

export interface TradeResult {
  id: string;
  acquisitionId: string;
  accountId: string;
  assetId: string;
  openedOn: string;
  closedOn: string | null;
  quantity: string;
  remainingQuantity: string;
  soldQuantity: string;
  transferredQuantity: string;
  status: "OPEN" | "PARTIAL" | "CLOSED";
  closedReason: "SOLD" | "TRANSFERRED" | null;
  costBasisBase: Amount;
  realizedPnlBase: Amount;
  periodRealizedPnlBase: Amount;
  unrealizedPnlBase: Amount;
  dividendsBase: Amount;
  contributionBase: Amount;
  holdingDays: number;
  benchmarkReturn: Amount;
  returnRate: Amount;
  priceReturnRate: Amount;
  memo: string;
  tags: string[];
}

export interface BenchmarkResult {
  assetId: string;
  returnType: "PRICE";
  from: string;
  to: string;
  returnRate: Amount;
  /** Dividend-excluded portfolio TWR for comparison with this PRICE benchmark. */
  portfolioPriceReturn: Amount;
  cashflowValue: Amount;
  pnl: Amount;
}

export interface MarketDataProvenance {
  kind: "PRICE" | "FX";
  asOf: string;
  observedOn: string | null;
  assetId?: string;
  base?: Currency;
  quote?: Currency;
  value: Amount;
  source: string | null;
  fetchedAt: string | null;
  ageDays: number | null;
  carried: boolean;
  stale: boolean;
  usable: boolean;
  inverted?: boolean;
  adjustment?: "RAW";
  transactionId?: string;
}

export interface AnalysisResult {
  filters: AnalysisFilters;
  summary: PortfolioSummary;
  history: HistoryPoint[];
  positions: PositionResult[];
  cash: CashResult[];
  trades: TradeResult[];
  issues: DataIssue[];
  benchmark: BenchmarkResult | null;
  provenance: MarketDataProvenance[];
  openingDate: string;
  calculationPolicy: "END_OF_DAY_V1";
}

export interface GoalProjectionInput {
  initial: string;
  monthlyContribution: string;
  /** Annual effective return as a ratio: "0.07" means 7%. */
  annualReturn: string;
  years: number;
}

export interface GoalProjectionPoint {
  month: number;
  year: number;
  value: string;
  contributions: string;
  profit: string;
}

export type GoalProjectionResult = Pick<GoalProjectionPoint, "year" | "value" | "contributions">[];

export interface GoalProjectionDetails {
  monthly: GoalProjectionPoint[];
  yearly: GoalProjectionPoint[];
  finalValue: Amount;
  totalContributions: Amount;
  totalGrowth: Amount;
  monthlyRate: Amount;
  issues: DataIssue[];
}
