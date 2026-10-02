import type { AssetInput, CostMethod, Currency, DataIssue, FxInput, LedgerTransaction } from "../domain";
import { Issues, decimal, text, validDate } from "./decimal";
import { Market } from "./market";
import type { HistoricalQuantity } from "./types";
import { checkBalances, isCurrency, prepareLedger } from "./validation";

export class FinanceValidationError extends Error {
  readonly issues: DataIssue[];

  constructor(issues: DataIssue[]) {
    super(issues.map(issue => issue.message).join("; "));
    this.name = "FinanceValidationError";
    this.issues = [...issues];
  }
}

export function convertCurrency(
  amount: string,
  from: Currency,
  to: Currency,
  date: string,
  fx: FxInput[],
): string | null {
  const value = decimal(amount);
  if (value === null || !isCurrency(from) || !isCurrency(to) || !validDate(date)) return null;
  if (from === to || value.isZero()) return text(value);
  const market = new Market([], [], fx, [], new Issues(), date);
  return text(market.convert(value, from, to, date));
}

export function historicalQuantities(
  transactions: LedgerTransaction[],
  assets: AssetInput[],
  date: string,
  costMethod: CostMethod = "FIFO",
): HistoricalQuantity[] {
  const issues = new Issues();
  if (!validDate(date)) {
    throw new FinanceValidationError([{
      code: "INVALID_DATE", message: "Quantity snapshot date must be an actual YYYY-MM-DD calendar date.",
      date, severity: "error",
    }]);
  }
  const parsed = prepareLedger(
    transactions.filter(tx => !validDate(tx.date) || tx.date <= date),
    assets, costMethod, issues,
  );
  const quantities = checkBalances(parsed, issues);
  const errors = issues.values.filter(issue => issue.severity === "error");
  if (errors.length) throw new FinanceValidationError(errors);
  return [...quantities.entries()]
    .filter(([, quantity]) => quantity.gt(0))
    .map(([key, quantity]) => {
      const [accountId, assetId] = JSON.parse(key) as [string, string];
      return { accountId, assetId, quantity: text(quantity)! };
    })
    .sort((a, b) => a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 :
      a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0);
}
