"use client";

import { useState } from "react";
import { ArrowDownUp, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/input";
import { assetClassLabels, dateTime, kindLabels, money, number, percent, quantity, sum, tone } from "./format";
import { AssetName, Hint, Metric, Panel, StatList, TableWrap } from "./shared";
import { TransactionEditor } from "./transaction-editor";
import { useWorkspace } from "./workspace-context";

export function Holdings() {
  const { data, filters, openTransaction } = useWorkspace();
  const [search, setSearch] = useState("");
  const [assetClass, setAssetClass] = useState("all");
  const [sort, setSort] = useState("value");
  const [selected, setSelected] = useState<string | null>(null);
  const positions = data.analysis.positions.filter((position) => {
    const asset = data.assets.find((item) => item.id === position.assetId);
    return (assetClass === "all" || asset?.assetClass === assetClass) && `${asset?.symbol} ${asset?.name}`.toLowerCase().includes(search.toLowerCase());
  }).sort((left, right) => (number(sort === "value" ? right.valueBase : right.unrealizedPnlBase) ?? -Infinity) - (number(sort === "value" ? left.valueBase : left.unrealizedPnlBase) ?? -Infinity));
  return <div className="view-stack">
    <div className="metric-grid metric-grid-three"><Metric label="투자 자산 평가액" value={money(sum(data.analysis.positions.map((position) => position.valueBase)), filters.currency)} detail="현금 제외 · 종료일 기준" /><Metric label="미실현 손익" value={money(data.analysis.summary.unrealizedPnl, filters.currency)} detail="보유분 평가 손익" /><Metric label="보유 현금" value={money(sum(data.analysis.cash.map((cash) => cash.valueBase)), filters.currency)} detail="통화별 잔액을 기준 통화로 환산" /></div>
    <Panel title="보유 자산" description="종목을 선택하면 계좌별 원가, 거래와 가격 출처를 확인할 수 있습니다.">
      <div className="table-toolbar"><div className="search-field"><Search size={16} /><Input aria-label="보유 종목 검색" value={search} placeholder="종목 이름 또는 코드" onChange={(event) => setSearch(event.target.value)} /></div><Select aria-label="보유 자산군" value={assetClass} onChange={(event) => setAssetClass(event.target.value)}><option value="all">전체 자산군</option>{Object.entries(assetClassLabels).filter(([key]) => key !== "CASH").map(([key, label]) => <option value={key} key={key}>{label}</option>)}</Select><Select aria-label="보유 자산 정렬" value={sort} onChange={(event) => setSort(event.target.value)}><option value="value">평가액순</option><option value="profit">평가 손익순</option></Select></div>
      {!positions.length ? <EmptyState title="해당하는 보유 자산이 없어요" description="검색 조건을 바꾸거나 매수 거래를 등록해 주세요." action={<Button onClick={openTransaction}>거래 추가</Button>} /> : <TableWrap><table><thead><tr><th>종목</th><th>계좌 / 자산군</th><th className="numeric">수량</th><th className="numeric">평균 원가</th><th className="numeric">평가액 ({filters.currency})</th><th className="numeric">미실현 손익</th><th className="numeric">비중</th></tr></thead><tbody>{positions.map((position) => {
        const asset = data.assets.find((item) => item.id === position.assetId);
        return <tr key={`${position.assetId}-${position.accountId}`}><td><AssetName asset={asset} onClick={() => setSelected(position.assetId)} /></td><td>{data.accounts.find((account) => account.id === position.accountId)?.name}<small className="cell-sub">{assetClassLabels[asset?.assetClass ?? ""] ?? "—"}</small></td><td className="numeric">{quantity(position.quantity)}</td><td className="numeric">{money(position.averageCost, asset?.currency)}<small className="cell-sub">{asset?.currency} · {data.user.costMethod === "FIFO" ? "선입선출" : "이동평균"}</small></td><td className="numeric font-semibold">{money(position.valueBase, filters.currency)}</td><td className={`numeric ${tone(position.unrealizedPnlBase)}`}>{money(position.unrealizedPnlBase, filters.currency)}</td><td className="numeric"><div className="weight-cell">{percent(position.weight)}<span><i style={{ width: `${Math.max(0, Math.min(100, (number(position.weight) ?? 0) * 100))}%` }} /></span></div></td></tr>;
      })}</tbody></table></TableWrap>}
    </Panel>
    <Panel title="계좌별 현금" description="KRW와 USD 잔액은 별도로 관리됩니다."><TableWrap><table><thead><tr><th>계좌</th><th>통화</th><th className="numeric">현지 통화 잔액</th><th className="numeric">환산 평가액 ({filters.currency})</th></tr></thead><tbody>{data.analysis.cash.map((cash) => <tr key={`${cash.accountId}-${cash.currency}`}><td>{data.accounts.find((account) => account.id === cash.accountId)?.name ?? "—"}</td><td><span className="badge">{cash.currency}</span></td><td className="numeric">{money(cash.balance, cash.currency)}</td><td className="numeric">{money(cash.valueBase, filters.currency)}</td></tr>)}</tbody></table></TableWrap>{!data.analysis.cash.length && <EmptyState description="입금 또는 매매 거래 후 현금 잔액이 표시됩니다." />}</Panel>
    {selected && <SecurityDetail assetId={selected} onClose={() => setSelected(null)} />}
  </div>;
}

function SecurityDetail({ assetId, onClose }: { assetId: string; onClose: () => void }) {
  const { data, filters } = useWorkspace();
  const [record, setRecord] = useState(false);
  const asset = data.assets.find((item) => item.id === assetId);
  const positions = data.analysis.positions.filter((position) => position.assetId === assetId);
  const transactions = data.transactions.filter((transaction) => transaction.assetId === assetId).sort((left, right) => right.date.localeCompare(left.date) || right.sequence - left.sequence);
  const price = [...data.marketData.prices].filter((item) => item.assetId === assetId && item.date <= filters.to).sort((left, right) => right.date.localeCompare(left.date))[0];
  const provenance = data.analysis.provenance.filter((item) => item.assetId === assetId);
  return <Dialog title={asset ? `${asset.name} · ${asset.symbol}` : "종목 상세"} description={`${asset?.exchange ?? ""} · ${assetClassLabels[asset?.assetClass ?? ""] ?? ""} · ${asset?.currency ?? ""}`} onClose={onClose} wide><div className="form-stack">
    <StatList entries={[{ label: "보유 수량", value: quantity(sum(positions.map((position) => position.quantity))) }, { label: "평가액", value: money(sum(positions.map((position) => position.valueBase)), filters.currency) }, { label: "평가 손익", value: money(sum(positions.map((position) => position.unrealizedPnlBase)), filters.currency) }, { label: "최근 관측 가격", value: money(price?.close, price?.currency) }, { label: "가격 기준일", value: price?.date || "자료 없음" }, { label: "가격 출처 / 수집일", value: price ? `${price.source} · ${dateTime(price.fetchedAt)}` : "직접 입력하거나 시세를 수집해 주세요." }, { label: "국가 · 섹터", value: `${asset?.country || "미분류"} · ${asset?.sector || "미분류"}` }, { label: "데이터 제공 설정", value: asset?.provider === "ALPHA_VANTAGE" ? "Alpha Vantage · 이용 권한 필요" : "수동 관리" }]} />
    {provenance.some((item) => !item.usable || item.stale) && <Hint>일부 계산일에 유효하지 않거나 오래된 가격이 있습니다. 상단 데이터 상태와 설정의 원본 관측치를 확인하세요.</Hint>}
    <h3 className="section-title">계좌별 원가와 평가</h3><TableWrap><table><thead><tr><th>계좌</th><th className="numeric">수량</th><th className="numeric">평균 원가</th><th className="numeric">매입 원가</th><th className="numeric">평가액</th></tr></thead><tbody>{positions.map((position) => <tr key={position.accountId}><td>{data.accounts.find((account) => account.id === position.accountId)?.name}</td><td className="numeric">{quantity(position.quantity)}</td><td className="numeric">{money(position.averageCost, asset?.currency)}</td><td className="numeric">{money(position.costBasisBase, filters.currency)}</td><td className="numeric">{money(position.valueBase, filters.currency)}</td></tr>)}</tbody></table></TableWrap>
    <div className="section-row"><h3>선택 기간의 거래</h3><Button size="sm" onClick={() => setRecord(true)}><ArrowDownUp />이 종목 거래 기록</Button></div>
    {!transactions.length ? <EmptyState description="선택 기간에 이 종목의 거래가 없습니다." /> : <TableWrap><table><thead><tr><th>거래일</th><th>유형</th><th className="numeric">수량</th><th className="numeric">단가 / 금액</th><th>메모</th></tr></thead><tbody>{transactions.map((transaction) => <tr key={transaction.id}><td>{transaction.date}</td><td>{kindLabels[transaction.kind]}</td><td className="numeric">{quantity(transaction.quantity)}</td><td className="numeric">{money(transaction.amount ?? transaction.price, transaction.currency)}</td><td>{transaction.memo || "—"}</td></tr>)}</tbody></table></TableWrap>}
    {record && <TransactionEditor defaultAssetId={assetId} onClose={() => setRecord(false)} />}
  </div></Dialog>;
}
