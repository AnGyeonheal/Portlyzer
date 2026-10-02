import Decimal from "decimal.js";
import type { WorkspaceData } from "@/lib/contracts";
import { assetClassLabels, sum } from "./format";

export const dimensions = { asset: "종목", assetClass: "자산군", country: "국가", sector: "섹터", currency: "통화", account: "계좌" } as const;
export type Dimension = keyof typeof dimensions;
export interface AllocationRow {
  key: string; name: string; value: string | null; weight: string | null;
  targetId?: string; target: string | null; difference: string | null; rebalance: string | null;
}

export function allocationRows(data: WorkspaceData, dimension: Dimension): AllocationRow[] {
  const grouped = new Map<string, { name: string; values: (string | null)[] }>();
  const add = (key: string, name: string, value: string | null) => {
    const group = grouped.get(key) ?? { name, values: [] };
    group.values.push(value);
    grouped.set(key, group);
  };
  for (const position of data.analysis.positions) {
    const asset = data.assets.find((item) => item.id === position.assetId);
    if (!asset) continue;
    const account = data.accounts.find((item) => item.id === position.accountId);
    const keys: Record<Dimension, [string, string]> = {
      asset: [asset.id, asset.name], assetClass: [asset.assetClass, assetClassLabels[asset.assetClass]],
      country: [asset.country || "UNKNOWN", asset.country || "미분류"],
      sector: [asset.sector || "UNKNOWN", asset.sector || "미분류"],
      currency: [asset.currency, asset.currency], account: [position.accountId, account?.name || "미지정"],
    };
    add(...keys[dimension], position.valueBase);
  }
  for (const cash of data.analysis.cash) {
    const account = data.accounts.find((item) => item.id === cash.accountId);
    const key = dimension === "account" ? cash.accountId : dimension === "currency" ? cash.currency : dimension === "asset" ? `CASH:${cash.currency}` : "CASH";
    const name = dimension === "account" ? account?.name || "미지정" : dimension === "currency" ? cash.currency : dimension === "asset" ? `${cash.currency} 현금` : "현금";
    add(key, name, cash.valueBase);
  }
  const targets = data.targets.filter((target) => target.dimension === dimension);
  for (const target of targets) {
    if (!grouped.has(target.key)) {
      const name = dimension === "asset" ? data.assets.find((asset) => asset.id === target.key)?.name : dimension === "account" ? data.accounts.find((account) => account.id === target.key)?.name : dimension === "assetClass" ? assetClassLabels[target.key] : target.key;
      grouped.set(target.key, { name: name || target.key, values: ["0"] });
    }
  }
  const total = data.analysis.summary.totalValue === null ? null : new Decimal(data.analysis.summary.totalValue);
  return [...grouped].map(([key, group]) => {
    const value = sum(group.values);
    const target = targets.find((item) => item.key === key);
    const weight = value !== null && total?.gt(0) ? new Decimal(value).div(total) : null;
    const desired = target ? new Decimal(target.percent).div(100) : null;
    return { key, name: group.name, value, weight: weight?.toString() ?? null, targetId: target?.id, target: desired?.toString() ?? null,
      difference: desired !== null && weight !== null ? weight.minus(desired).toString() : null,
      rebalance: desired !== null && total !== null && value !== null ? total.times(desired).minus(value).toString() : null };
  }).sort((left, right) => new Decimal(right.value ?? "0").cmp(left.value ?? "0"));
}
