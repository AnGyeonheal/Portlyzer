"use client";

import { ArrowDownRight, ArrowUpRight, Info, Plus, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import type { AssetDto } from "@/lib/contracts";
import { cn } from "@/components/ui/utils";
import { Button } from "@/components/ui/button";
import { number, percent } from "./format";

export function Brand({ light = false }: { light?: boolean }) {
  return <span className={cn("brand", light && "brand-light")}><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>Portlyzer<span className="brand-dot">.</span></span></span>;
}

export function Panel({ title, description, action, children, className }: {
  title?: string; description?: string; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section className={cn("panel", className)}>{(title || action) && <div className="panel-header"><div>{title && <h2>{title}</h2>}{description && <p>{description}</p>}</div>{action}</div>}{children}</section>;
}

export function Metric({ label, value, detail, change, icon, featured = false }: {
  label: string; value: string; detail?: string; change?: string | null; icon?: ReactNode; featured?: boolean;
}) {
  const positive = (number(change) ?? 0) >= 0;
  return <div className={cn("metric", featured && "metric-featured")}><div className="metric-label">{label}<span>{icon ?? <Wallet size={17} />}</span></div><div className="metric-value">{value}</div><div className="metric-detail">{change !== undefined && <span className={cn("metric-change", positive ? "up" : "down")}>{change !== null && (positive ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />)}{percent(change, true)}</span>}{detail && <span>{detail}</span>}</div></div>;
}

export function AssetBadge({ asset, small = false }: { asset?: AssetDto; small?: boolean }) {
  const seed = [...(asset?.symbol || "")].reduce((value, letter) => value + letter.charCodeAt(0), 0) % 5;
  return <span className={cn("asset-avatar", `asset-color-${seed}`, small && "asset-avatar-small")} aria-hidden="true">{(asset?.symbol || "?").slice(0, 2)}</span>;
}

export function AssetName({ asset, onClick }: { asset?: AssetDto; onClick?: () => void }) {
  const content = <><AssetBadge asset={asset} /><span className="asset-name-text"><strong>{asset?.name || "알 수 없는 종목"}</strong><small>{asset?.symbol || "—"}{asset?.exchange ? ` · ${asset.exchange}` : ""}</small></span></>;
  return onClick ? <button type="button" className="asset-name asset-link" onClick={onClick}>{content}</button> : <span className="asset-name">{content}</span>;
}

export function Hint({ children }: { children: ReactNode }) {
  return <div className="notice notice-info"><Info size={17} /><div>{children}</div></div>;
}

export function AddButton({ children = "추가하기", onClick }: { children?: ReactNode; onClick: () => void }) {
  return <Button size="sm" onClick={onClick}><Plus />{children}</Button>;
}

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="table-wrap" tabIndex={0} role="region" aria-label="가로로 스크롤할 수 있는 데이터 표">{children}</div>;
}

export function StatList({ entries }: { entries: { label: string; value: ReactNode }[] }) {
  return <dl className="stat-list">{entries.map((entry) => <div key={entry.label}><dt>{entry.label}</dt><dd>{entry.value}</dd></div>)}</dl>;
}
