"use client";

import { ArrowRight, ArrowUpRight, CalendarDays, ChartNoAxesCombined, CircleDollarSign, Plus, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { allocationRows } from "./allocation-data";
import { AllocationDonut, ValueChart } from "./charts";
import { colors, money, number, percent, tone } from "./format";
import { AssetName, Hint, Metric, Panel, TableWrap } from "./shared";
import { useWorkspace } from "./workspace-context";

export function Dashboard() {
  const { data, filters, setFilters, navigate, openTransaction } = useWorkspace();
  const { summary } = data.analysis;
  const allocations = allocationRows(data, "assetClass");
  const topPositions = [...data.analysis.positions].sort((left, right) => (number(right.valueBase) ?? -Infinity) - (number(left.valueBase) ?? -Infinity)).slice(0, 5);
  const upcoming = [...data.dividends.upcoming].filter((event) => !event.reconciled).sort((left, right) => (left.payDate || "9999").localeCompare(right.payDate || "9999")).slice(0, 3);
  const dateLabel = `${filters.from.replaceAll("-", ".")} – ${filters.to.replaceAll("-", ".")}`;

  function preset(months: number | "year") {
    const to = new Date(`${filters.to}T12:00:00`);
    if (months === "year") setFilters({ ...filters, from: `${filters.to.slice(0, 4)}-01-01` });
    else {
      to.setMonth(to.getMonth() - months);
      const from = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, "0")}-${String(to.getDate()).padStart(2, "0")}`;
      setFilters({ ...filters, from });
    }
  }

  return <div className="view-stack">
    {!data.accounts.length && <div className="welcome-banner"><div><span className="eyebrow">YOUR FIRST CHAPTER</span><h2>작은 기록으로 시작하는, 더 선명한 투자</h2><p>계좌를 만들고 첫 거래를 기록해 보세요. 모든 분석은 내 기록에서 시작됩니다.</p></div><Button onClick={() => navigate("settings")}><Plus />첫 계좌 만들기</Button></div>}
    <div className="metric-grid">
      <Metric label="총 자산 평가액" value={money(summary.totalValue, filters.currency)} detail="현금 포함 · 선택 종료일 기준" featured icon={<Wallet size={19} />} />
      <Metric label="기간 총 손익" value={money(summary.totalPnl, filters.currency)} change={summary.simpleReturn} detail="단순 수익률" icon={<ArrowUpRight size={19} />} />
      <Metric label="총수익 시간가중수익률" value={percent(summary.twr, true)} detail="배당 포함 TWR · 입출금 영향 분리" icon={<ChartNoAxesCombined size={19} />} />
      <Metric label="받은 배당금" value={money(summary.dividends, filters.currency)} detail="선택 기간 · 세후 실제 수령" icon={<CircleDollarSign size={19} />} />
    </div>
    <div className="dashboard-main-grid">
      <Panel title="자산의 흐름" description={dateLabel} action={<div className="segmented" role="group" aria-label="빠른 기간 선택"><button onClick={() => preset(1)}>1개월</button><button onClick={() => preset(3)}>3개월</button><button className={filters.from === `${filters.to.slice(0, 4)}-01-01` ? "active" : ""} onClick={() => preset("year")}>올해</button><button onClick={() => preset(12)}>1년</button></div>}>
        <div className="chart-legend"><span><i style={{ background: "#15806f" }} />실제 총 평가액</span><span><i className="legend-dashed" />누적 순입금</span>{data.analysis.benchmark && <span><i style={{ background: "#daa95b" }} />동일 외부 입출금 · PRICE</span>}<button onClick={() => navigate("performance")}>상세 분석<ArrowRight size={13} /></button></div>
        <ValueChart history={data.analysis.history} currency={filters.currency} benchmark={!!data.analysis.benchmark} />
        <div className="chart-footer"><span>입출금과 투자 성과를 구분해 보세요.</span><span>기준 통화 <strong>{filters.currency}</strong></span></div>
      </Panel>
      <Panel title="내 자산의 구성" description="현금 포함 · 자산군별" action={<Button variant="ghost" size="icon" aria-label="자산 배분 상세 보기" onClick={() => navigate("allocation")}><ArrowUpRight /></Button>}>
        <AllocationDonut data={allocations} currency={filters.currency} total={summary.totalValue} />
        <div className="allocation-legend">{allocations.map((row, index) => <div key={row.key}><span><i style={{ background: colors[index % colors.length] }} />{row.name}</span><strong>{percent(row.weight)}</strong></div>)}</div>
      </Panel>
    </div>
    <div className="dashboard-main-grid">
      <Panel title="주요 보유 자산" description="종료일 평가액 기준 상위 5개 계좌·종목" action={<Button variant="ghost" size="sm" onClick={() => navigate("holdings")}>전체 보기<ArrowRight /></Button>}>
        {!topPositions.length ? <EmptyState title="포트폴리오가 기다리고 있어요" description="첫 매수를 기록하면 보유 자산이 여기에 나타납니다." action={<Button variant="outline" onClick={openTransaction}><Plus />거래 기록하기</Button>} /> : <TableWrap><table><thead><tr><th>자산</th><th className="numeric">평가액</th><th className="numeric">평가 손익</th><th className="numeric">비중</th></tr></thead><tbody>{topPositions.map((position) => <tr key={`${position.accountId}-${position.assetId}`}><td><AssetName asset={data.assets.find((asset) => asset.id === position.assetId)} onClick={() => navigate("holdings")} /><small className="cell-sub">{data.accounts.find((account) => account.id === position.accountId)?.name}</small></td><td className="numeric font-semibold">{money(position.valueBase, filters.currency)}</td><td className={`numeric ${tone(position.unrealizedPnlBase)}`}>{money(position.unrealizedPnlBase, filters.currency)}</td><td className="numeric">{percent(position.weight)}</td></tr>)}</tbody></table></TableWrap>}
      </Panel>
      <Panel title="배당 다이어리" description="예정과 수령을 구분해서 확인하세요" action={<span className="subtle-icon"><CalendarDays size={18} /></span>}>
        {!upcoming.length ? <EmptyState title="등록된 배당 일정이 없어요" description="공시나 나만의 추정 근거를 기록하고 실제 수령 내역과 대조해 보세요." /> : <div className="dividend-diary">{upcoming.map((event) => {
          const asset = data.assets.find((item) => item.id === event.assetId);
          return <button key={event.id} onClick={() => navigate("dividends")}><div className="diary-date"><strong>{event.payDate ? event.payDate.slice(8) : "?"}</strong><span>{event.payDate ? `${Number(event.payDate.slice(5, 7))}월` : "지급일 미정"}</span></div><div><strong>{asset?.name ?? "종목"}</strong><small>{event.status === "ANNOUNCED" ? "공시" : "추정"} · 주당 {money(event.amountPerShare, event.currency)}</small></div><span className="diary-value">{money(event.expectedGrossBase, filters.currency)}<small>예상 세전</small></span></button>;
        })}</div>}
        <div className="panel-bottom-link"><button onClick={() => navigate("dividends")}>나의 배당 일정 보기<ArrowRight size={15} /></button></div>
      </Panel>
    </div>
    <Hint>총수익 TWR에는 배당이 포함됩니다. 가상 벤치마크는 실제 외부 입출금만 동일하게 적용한 PRICE 전략으로 배당 재투자가 없으며, 같은 배당 기준의 수익률 비교는 수익률 분석에서 확인하세요. &lsquo;—&rsquo;는 누락 또는 계산 불가이며 0을 뜻하지 않습니다. 과거 성과와 추정치는 미래 수익을 보장하지 않습니다.</Hint>
  </div>;
}
