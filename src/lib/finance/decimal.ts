import DecimalJs from "decimal.js";
import type { DataIssue } from "../domain";

// A private constructor prevents application-wide Decimal configuration changes.
export const Decimal = DecimalJs.clone({
  precision: 50,
  rounding: DecimalJs.ROUND_HALF_EVEN,
});
export type D = DecimalJs;
export type MaybeD = D | null;
export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);
const DAY_MS = 86_400_000;

export function decimal(value: unknown): MaybeD {
  if (
    typeof value !== "string" || value.length > 128 ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
  ) return null;
  try {
    const result = new Decimal(value);
    return result.isFinite() && (result.isZero() || Math.abs(result.e) <= 100)
      ? result : null;
  } catch {
    return null;
  }
}

export function text(value: MaybeD): string | null {
  return value === null ? null : value.isZero() ? "0" : value.toFixed();
}

export function add(a: MaybeD, b: MaybeD): MaybeD {
  return a === null || b === null ? null : a.plus(b);
}

export function sub(a: MaybeD, b: MaybeD): MaybeD {
  return a === null || b === null ? null : a.minus(b);
}

export function mul(a: MaybeD, b: MaybeD): MaybeD {
  return a === null || b === null ? null : a.times(b);
}

export function sum(values: Iterable<MaybeD>): MaybeD {
  let result: MaybeD = ZERO;
  for (const value of values) result = add(result, value);
  return result;
}

export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && value.slice(0, 4) !== "0000" &&
    new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) -
    Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS);
}

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString().slice(0, 10);
}

export class Issues {
  readonly values: DataIssue[] = [];
  private readonly seen = new Set<string>();

  add(issue: DataIssue): void {
    const key = JSON.stringify([
      issue.code, issue.date, issue.transactionId, issue.assetId, issue.message,
    ]);
    if (!this.seen.has(key)) {
      this.seen.add(key);
      this.values.push(issue);
    }
  }
}
