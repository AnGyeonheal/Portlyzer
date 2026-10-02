import { Decimal, ONE, ZERO, daysBetween, decimal, text, validDate, type D, type MaybeD } from "./decimal";
import type { XirrCashFlow, XirrOptions, XirrResult, XirrStatus } from "./types";

const DEFAULT_MIN_LOG = -32;
const DEFAULT_MAX_LOG = 32;

export function unavailableXirr(status: XirrStatus, message: string, days = 0): XirrResult {
  return {
    value: null, annualized: null, cumulative: null, status, roots: [],
    iterations: 0, days, message,
    searchBounds: { minLogGrowth: String(DEFAULT_MIN_LOG), maxLogGrowth: String(DEFAULT_MAX_LOG) },
  };
}

interface Flow {
  time: D;
  amount: D;
}

interface Root {
  x: D;
  iterations: number;
  converged: boolean;
}

/**
 * ACT/365 XIRR in log-growth space. A positive exponential rescaling keeps every
 * term bounded even close to -100% or for long dated cash flows.
 */
export function calculateXirr(cashflows: XirrCashFlow[], options: XirrOptions = {}): XirrResult {
  const min = options.minLogGrowth ?? DEFAULT_MIN_LOG;
  const max = options.maxLogGrowth ?? DEFAULT_MAX_LOG;
  const maxIterations = options.maxIterations ?? 160;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max ||
    min < -100 || max > 100 || !Number.isSafeInteger(maxIterations) ||
    maxIterations < 1 || maxIterations > 10_000) {
    return unavailableXirr("INVALID_INPUT", "Invalid root-search bounds or iteration limit.");
  }
  const byDate = new Map<string, D>();
  for (const row of cashflows) {
    const amount = decimal(row.amount);
    if (!validDate(row.date) || amount === null) {
      return unavailableXirr("INVALID_INPUT", "Cash flows require valid dates and finite decimal amounts.");
    }
    byDate.set(row.date, (byDate.get(row.date) ?? ZERO).plus(amount));
  }
  const dated = [...byDate.entries()].filter(([, amount]) => !amount.isZero())
    .sort(([a], [b]) => a.localeCompare(b));
  const days = dated.length ? daysBetween(dated[0][0], dated[dated.length - 1][0]) : 0;
  const empty = (status: XirrStatus, message: string) => ({
    ...unavailableXirr(status, message, days),
    searchBounds: { minLogGrowth: String(min), maxLogGrowth: String(max) },
  });
  if (dated.length < 2 || days === 0 ||
    !dated.some(([, amount]) => amount.gt(0)) || !dated.some(([, amount]) => amount.lt(0))) {
    return empty("NO_SOLUTION", "At least one investment and receipt on different dates are required; same-day flows are netted.");
  }
  const scale = dated.reduce((largest, [, value]) => Decimal.max(largest, value.abs()), ZERO);
  const flows: Flow[] = dated.map(([date, amount]) => ({
    time: new Decimal(daysBetween(dated[0][0], date)).div(365),
    amount: amount.div(scale),
  }));
  const lastTime = flows[flows.length - 1].time;
  const valueAt = (x: D, derivative = false): D => {
    let value = ZERO;
    for (const flow of flows) {
      const exponent = x.lt(0) ? x.times(lastTime.minus(flow.time)) : x.negated().times(flow.time);
      const coefficient = derivative ? flow.amount.times(flow.time).negated() : flow.amount;
      if (!coefficient.isZero()) value = value.plus(coefficient.times(exponent.exp()));
    }
    return value;
  };
  const numberFlows = flows.map(flow => ({ time: flow.time.toNumber(), amount: flow.amount.toNumber() }));
  const endTime = lastTime.toNumber();
  // Floating-point arithmetic locates brackets only; cash amounts, residuals,
  // final bisection and published returns all use the private Decimal context.
  const scanValue = (x: number, derivative = false): number => {
    let value = 0;
    let compensation = 0;
    for (const flow of numberFlows) {
      const exponent = x < 0 ? x * (endTime - flow.time) : -x * flow.time;
      const coefficient = derivative ? -flow.amount * flow.time : flow.amount;
      const term = coefficient * Math.exp(exponent) - compensation;
      const next = value + term;
      compensation = (next - value) - term;
      value = next;
    }
    return value;
  };
  const refine = (low: D, high: D, derivative = false): Root => {
    let left = low;
    let right = high;
    let leftValue = valueAt(left, derivative);
    if (leftValue.isZero()) return { x: left, iterations: 0, converged: true };
    if (valueAt(right, derivative).isZero()) return { x: right, iterations: 0, converged: true };
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const middle = left.plus(right).div(2);
      const value = valueAt(middle, derivative);
      if (value.isZero() || right.minus(left).abs().lte("1e-26")) {
        return { x: middle, iterations: iteration, converged: true };
      }
      if (value.isPositive() === leftValue.isPositive()) {
        left = middle;
        leftValue = value;
      } else {
        right = middle;
      }
    }
    return { x: left.plus(right).div(2), iterations: maxIterations, converged: false };
  };
  const grid = new Set<number>([min, max]);
  for (let i = 0; i <= 256; i++) grid.add(min + (max - min) * i / 256);
  for (let i = -200; i <= 200; i++) {
    const x = i / 200;
    if (x >= min && x <= max) grid.add(x);
  }
  const baseGrid = [...grid].sort((a, b) => a - b);
  const points = baseGrid.map(x => new Decimal(x));
  let iterations = 0;
  let failed = false;
  // Stationary points expose two roots inside one scan interval and tangent roots.
  for (let i = 1; i < baseGrid.length; i++) {
    const a = scanValue(baseGrid[i - 1], true);
    const b = scanValue(baseGrid[i], true);
    if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
      const root = refine(new Decimal(baseGrid[i - 1]), new Decimal(baseGrid[i]), true);
      iterations += root.iterations;
      if (root.converged) points.push(root.x);
      else failed = true;
    }
  }
  points.sort((a, b) => a.cmp(b));
  const roots: D[] = [];
  const remember = (root: D) => {
    if (!roots.some(existing => existing.minus(root).abs().lt("1e-18"))) roots.push(root);
  };
  // Use Decimal at every final sample, so a rounded scan cannot select a root.
  let previous = points[0];
  let previousValue = valueAt(previous);
  if (previousValue.isZero()) remember(previous);
  for (let i = 1; i < points.length; i++) {
    const current = points[i];
    const currentValue = valueAt(current);
    if (currentValue.isZero() ||
      (currentValue.abs().lt("1e-35") && valueAt(current, true).abs().lt("1e-20"))) {
      remember(current);
    }
    if ((previousValue.lt(0) && currentValue.gt(0)) || (previousValue.gt(0) && currentValue.lt(0))) {
      const root = refine(previous, current);
      iterations += root.iterations;
      if (root.converged) remember(root.x);
      else failed = true;
    }
    previous = current;
    previousValue = currentValue;
  }
  roots.sort((a, b) => a.cmp(b));
  const rates = roots.map(root => text(root.exp().minus(1))!);
  const result = {
    ...empty(roots.length > 1 ? "MULTIPLE_ROOTS" : failed ? "NON_CONVERGENT" : roots.length ? "CONVERGED" : "NO_SOLUTION",
      roots.length > 1 ? "Multiple admissible roots exist; no single money-weighted return is selected." :
        failed ? "A detected bracket did not converge within the iteration limit." :
          roots.length ? "Unique root found within the disclosed finite search domain." :
            "No root found within the disclosed finite search domain."),
    roots: rates,
    iterations,
  };
  if (result.status === "CONVERGED") {
    result.value = rates[0];
    result.annualized = rates[0];
    result.cumulative = text(roots[0].times(new Decimal(days).div(365)).exp().minus(1));
  }
  return result;
}

export function annualize(returnRate: MaybeD, days: number): MaybeD {
  if (returnRate === null || days <= 0 || returnRate.lt(-1)) return null;
  return ONE.plus(returnRate).pow(new Decimal(365).div(days)).minus(1);
}

export function endOfDayReturn(previous: MaybeD, current: MaybeD, flow: MaybeD): MaybeD {
  if (previous === null || current === null || flow === null) return null;
  const adjusted = current.minus(flow);
  if (previous.gt(0) && adjusted.gte(0)) return adjusted.div(previous).minus(1);
  if (previous.isZero() && adjusted.isZero()) return ZERO;
  return null;
}
