import { Decimal, ONE, ZERO, decimal, text } from "./decimal";
import type { GoalProjectionDetails, GoalProjectionInput, GoalProjectionPoint, GoalProjectionResult } from "./types";

export function projectGoal(input: GoalProjectionInput): GoalProjectionResult {
  return projectGoalDetails(input).yearly.map(({ year, value, contributions }) => ({ year, value, contributions }));
}

export function projectGoalDetails(input: GoalProjectionInput): GoalProjectionDetails {
  const initial = decimal(input.initial);
  const contribution = decimal(input.monthlyContribution);
  const annual = decimal(input.annualReturn);
  const invalid = initial === null || initial.lt(0) || contribution === null || contribution.lt(0) ||
    annual === null || annual.lt(-1) || !Number.isInteger(input.years) || input.years < 0 || input.years > 100;
  if (invalid) {
    return {
      monthly: [], yearly: [], finalValue: null, totalContributions: null, totalGrowth: null, monthlyRate: null,
      issues: [{ code: "INVALID_PROJECTION", message: "Use nonnegative initial capital/monthly contributions, annual effective return ≥ -1, and integer years from 0 to 100.", severity: "error" }],
    };
  }
  const monthlyRate = ONE.plus(annual).pow(ONE.div(12)).minus(1);
  let value = initial;
  let contributions = initial;
  const monthly: GoalProjectionPoint[] = [{
    month: 0, year: 0, value: text(value)!, contributions: text(contributions)!, profit: "0",
  }];
  for (let month = 1; month <= input.years * 12; month++) {
    value = value.times(ONE.plus(monthlyRate)).plus(contribution);
    contributions = contributions.plus(contribution);
    monthly.push({
      month, year: new Decimal(month).div(12).toNumber(),
      value: text(value)!, contributions: text(contributions)!,
      profit: text(value.minus(contributions))!,
    });
  }
  return {
    monthly,
    yearly: monthly.filter(point => point.month % 12 === 0),
    finalValue: text(value),
    totalContributions: text(contributions),
    totalGrowth: text(value.minus(contributions)),
    monthlyRate: text(monthlyRate.eq(ZERO) ? ZERO : monthlyRate),
    issues: [],
  };
}
