"use client";

import Decimal from "decimal.js";
import { useState } from "react";
import { Pencil, Search } from "lucide-react";
import type { TransactionDto } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/input";
import { money, percent, quantity, sum, tone } from "./format";
import { AssetName, Hint, Metric, Panel, TableWrap } from "./shared";
import { TransactionEditor } from "./transaction-editor";
import { useWorkspace } from "./workspace-context";

const statusLabels: Record<string, string> = { OPEN: "보유 중", PARTIAL: "일부 청산", CLOSED: "청산 완료" };

export function TradeAnalysis() {
  const { data, filters } = useWorkspace();
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<TransactionDto | null>(null);
  const trades = data.analysis.trades.filter((trade) => {
    const asset = data.assets.find((item) => item.id === trade.assetId);
    return (status === "all" || trade.status === status) && `${asset?.name ?? ""} ${asset?.symbol ?? ""} ${trade.memo} ${trade.tags.join(" ")}`.toLowerCase().includes(search.toLowerCase());
  });
  const closed = trades.filter((trade) => trade.status === "CLOSED" && trade.closedReason !== "TRANSFERRED" && trade.realizedPnlBase !== null);
  const wins = closed.filter((trade) => new Decimal(trade.realizedPnlBase!).gt(0)).length;
  const winRate = closed.length ? new Decimal(wins).div(closed.length).toString() : null;
  const averageDays = closed.length ? new Decimal(closed.reduce((total, trade) => total + trade.holdingDays, 0)).div(closed.length).toFixed(1) : null;
  return <div className="view-stack">
    <div className="metric-grid"><Metric label="분석 대상 매수 묶음" value={`${trades.length}건`} detail="원가 묶음(로트) 단위" /><Metric label="청산 묶음 승률" value={percent(winRate)} detail={`${wins}건 수익 / ${closed.length}건 청산 · 이체 제외`} /><Metric label="기간 실현 손익" value={money(sum(trades.map((trade) => trade.periodRealizedPnlBase)), filters.currency)} detail="현재 검색·상태 조건의 합계" /><Metric label="청산분 평균 보유 기간" value={averageDays === null ? "—" : `${averageDays}일`} detail="단순 평균 · 이체 제외" /></div>
    <Panel title="매매를 돌아보는 시간" description="분할 매도와 계좌 이체를 구분하고, 매수 시점의 메모를 함께 살펴보세요."><div className="table-toolbar"><div className="search-field"><Search size={17} /><Input value={search} aria-label="매매 분석 검색" placeholder="종목, 메모, 태그 검색" onChange={(event) => setSearch(event.target.value)} /></div><Select value={status} aria-label="매매 상태 필터" onChange={(event) => setStatus(event.target.value)}><option value="all">전체 상태</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></div>
      {!trades.length ? <EmptyState title="분석할 매매가 없어요" description="매수 거래를 등록하거나 조회 조건을 바꾸어 주세요." /> : <TableWrap><table><thead><tr><th>종목 / 계좌</th><th>진입 / 종료일</th><th>상태</th><th className="numeric">매수 / 잔여 수량</th><th className="numeric">보유 일수</th><th className="numeric">누적 실현 손익</th><th className="numeric">총수익률 (배당 포함)</th><th className="numeric">배당 제외 수익률</th><th className="numeric">동일 기간 PRICE</th><th>메모 / 태그</th></tr></thead><tbody>{trades.map((trade) => {
        const original = data.transactions.find((transaction) => transaction.id === trade.acquisitionId);
        return <tr key={trade.id}><td><AssetName asset={data.assets.find((asset) => asset.id === trade.assetId)} /><small className="cell-sub">{data.accounts.find((account) => account.id === trade.accountId)?.name}</small></td><td className="nowrap">{trade.openedOn}<small className="cell-sub">{trade.closedOn || "미청산"}</small></td><td><span className={`badge ${trade.status === "CLOSED" ? "badge-neutral" : "badge-success"}`}>{statusLabels[trade.status]}</span>{trade.closedReason === "TRANSFERRED" && <small className="cell-sub">계좌 이체로 종료</small>}</td><td className="numeric">{quantity(trade.quantity)}<small className="cell-sub">잔여 {quantity(trade.remainingQuantity)}</small></td><td className="numeric">{trade.holdingDays}일</td><td className={`numeric ${tone(trade.realizedPnlBase)}`}>{money(trade.realizedPnlBase, filters.currency)}</td><td className={`numeric ${tone(trade.returnRate)}`}>{percent(trade.returnRate, true)}</td><td className={`numeric ${tone(trade.priceReturnRate)}`}>{percent(trade.priceReturnRate, true)}</td><td className="numeric">{percent(trade.benchmarkReturn, true)}<small className="cell-sub">배당 제외 가격 수익률</small></td><td className="memo-cell">{trade.memo || "—"}<div className="tag-row">{trade.tags.map((tag) => <span className="tag" key={tag}>#{tag}</span>)}</div>{original && <Button variant="ghost" size="sm" onClick={() => setEditing(original)} aria-label={`${trade.openedOn} 매수 메모 수정`}><Pencil />기록 수정</Button>}</td></tr>;
      })}</tbody></table></TableWrap>}
    </Panel><Hint>승률은 수익이 양수인 완전 청산 묶음의 비율이며, 미청산·부분 청산·계좌 이체·계산 불가 묶음은 제외합니다. 총수익률에는 귀속된 세후 배당이 포함됩니다. PRICE와의 비교는 별도 ‘배당 제외 수익률’을 사용하세요. 벤치마크는 매도분의 실제 매도일과 잔여분의 조회 종료일을 원가 가중으로 반영하며 배당 재투자는 없습니다. 과거 패턴은 매수·매도 신호가 아닙니다.</Hint>
    {editing && <TransactionEditor transaction={editing} onClose={() => setEditing(null)} />}
  </div>;
}
