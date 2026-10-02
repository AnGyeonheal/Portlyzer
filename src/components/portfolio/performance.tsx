"use client";

import { useState } from "react";
import { Activity, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { ReturnChart, ValueChart } from "./charts";
import { money, number, percent, tone } from "./format";
import { Hint, Metric, Panel, StatList, TableWrap } from "./shared";
import { useWorkspace } from "./workspace-context";

const mwrStatuses: Record<string, string> = {
  CONVERGED: "계산 완료", MULTIPLE_ROOTS: "복수 해 · 단일 수익률 제시 불가",
  NO_SOLUTION: "해 없음", NON_CONVERGENT: "미수렴", MISSING_DATA: "데이터 부족", INVALID_INPUT: "계산 조건 미충족",
};

export function Performance() {
  const { data, filters, navigate } = useWorkspace();
  const [chart, setChart] = useState<"total" | "price" | "value">("total");
  const [page, setPage] = useState(0);
  const { summary, benchmark, history } = data.analysis;
  const rows = [...history].reverse();
  const pageSize = 15;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  const benchmarkAsset = data.assets.find((asset) => asset.id === benchmark?.assetId);
  const hasPriceHistory = history.some((point) => number(point.portfolioPriceTwr) !== null);
  return <div className="view-stack">
    <div className="metric-grid"><Metric label="총수익 시간가중수익률 · TWR" value={percent(summary.twr, true)} detail={`배당 포함 · 연환산 ${percent(summary.twrAnnualized, true)}`} featured /><Metric label="금액가중수익률 · MWR" value={percent(summary.mwr.value, true)} detail={`연환산 XIRR · ${mwrStatuses[summary.mwr.status] || summary.mwr.status}`} /><Metric label="최대 낙폭 · MDD" value={percent(summary.mdd)} detail="선택 기간의 최대 고점 대비 하락" icon={<Activity size={19} />} /><Metric label="단순 수익률" value={percent(summary.simpleReturn, true)} detail="배당 포함 손익 / 계산 정책상 투자 원금" /></div>
    <Panel title="기록으로 확인하는 투자 성과" description={`${filters.from} – ${filters.to} · ${filters.currency} 기준 · 총수익과 가격 기준을 구분합니다.`} action={<div className="segmented" role="group" aria-label="성과 차트 유형"><button className={chart === "total" ? "active" : ""} onClick={() => setChart("total")}>총수익 TWR</button><button className={chart === "price" ? "active" : ""} onClick={() => setChart("price")}>배당 제외 비교</button><button className={chart === "value" ? "active" : ""} onClick={() => setChart("value")}>평가액</button></div>}>
      {chart === "value" ? <ValueChart history={history} currency={filters.currency} benchmark={!!benchmark} /> : <ReturnChart history={history} benchmark={!!benchmark} mode={chart} />}
      <Hint>{chart === "total" ? "총수익 TWR에는 배당이 포함됩니다. 배당을 제외하는 PRICE 벤치마크와 직접 같은 기준으로 비교하지 않습니다." : chart === "price" ? "배당 제외 포트폴리오 TWR와 PRICE 벤치마크를 같은 배당 기준으로 비교합니다." : "실제 평가액에는 배당 현금이 반영됩니다. 가상 PRICE 벤치마크는 실제 외부 입출금만 동일하게 적용하며 배당 재투자를 포함하지 않습니다."}{chart === "price" && !hasPriceHistory && " 일별 배당 제외 값은 제공되지 않거나 계산할 수 없습니다. 아래 기간 비교 카드의 값을 확인하세요."}</Hint>
      <div className="chart-footer"><span>{benchmarkAsset ? `벤치마크: ${benchmarkAsset.name} (${benchmarkAsset.symbol})` : "벤치마크가 설정되지 않았습니다."}</span><Button variant="ghost" size="sm" onClick={() => navigate("settings")}>벤치마크 설정</Button></div>
    </Panel>
    <div className="two-column">
      <Panel title="손익을 나누어 보면" description="선택 기간의 현금흐름과 투자 손익"><StatList entries={[
        { label: "시작 평가액", value: money(summary.openingValue, filters.currency) },
        { label: "기간 순입금", value: money(summary.periodNetContributions, filters.currency) },
        { label: "종료 평가액", value: money(summary.totalValue, filters.currency) },
        { label: "기간 총 손익", value: <span className={tone(summary.totalPnl)}>{money(summary.totalPnl, filters.currency)}</span> },
        { label: "기간 실현 손익", value: money(summary.realizedPnl, filters.currency) },
        { label: "현재 보유분 미실현 손익", value: money(summary.unrealizedPnl, filters.currency) },
        { label: "세후 배당", value: money(summary.dividends, filters.currency) },
        { label: "수수료 / 세금", value: `${money(summary.fees, filters.currency)} / ${money(summary.taxes, filters.currency)}` },
      ]} /></Panel>
      <Panel title="배당 제외 기준 비교" description="포트폴리오 배당 제외 TWR ↔ 벤치마크 PRICE · 총수익 TWR과 별도">
        {benchmark ? <><StatList entries={[{ label: "비교 종목", value: benchmarkAsset?.name ?? benchmark.assetId }, { label: "수익률 비교 기준", value: <span className="badge badge-warning">배당 제외 · PRICE</span> }, { label: "포트폴리오 · 배당 제외 TWR", value: percent(benchmark.portfolioPriceReturn, true) }, { label: "벤치마크 · PRICE 수익률", value: percent(benchmark.returnRate, true) }, { label: "동일 외부 입출금 · PRICE 평가액", value: money(benchmark.cashflowValue, filters.currency) }, { label: "동일 외부 입출금 · PRICE 손익", value: money(benchmark.pnl, filters.currency) }]} /><Hint>비교 수익률은 배당을 제외한 기준입니다. 위의 총수익 TWR에는 배당이 포함되므로 별도 지표로 보세요. 가상 벤치마크는 실제 외부 입출금의 날짜·금액을 동일하게 적용하는 PRICE 전략이며 배당 재투자는 없습니다. 원시 종가(RAW)를 사용하고, 계산 불가 항목은 &lsquo;—&rsquo;로 표시합니다.</Hint></> : <EmptyState title="비교의 기준을 정해 보세요" description="설정에서 등록한 종목을 벤치마크로 선택하세요. 가격이 없는 날짜는 계산할 수 없습니다." action={<Button variant="outline" onClick={() => navigate("settings")}>설정 열기</Button>} />}
      </Panel>
    </div>
    <details className="panel calculation-notes"><summary>수익률은 어떻게 계산하나요? <ChevronDown size={17} /></summary><div className="formula-grid"><div><h3>총수익과 배당 제외 TWR</h3><p>총수익 TWR은 배당을 포함하며 일별 외부 입출금 영향을 분리해 연결합니다. 배당 제외 TWR은 엔진의 별도 자본이득 기준 지표이며 PRICE 벤치마크와 비교합니다. 총수익 TWR에서 단순히 배당률을 빼거나 누락 값을 대신 넣지 않습니다.</p></div><div><h3>금액가중수익률 (MWR)</h3><p>실제 투자금의 크기와 날짜를 반영하는 연환산 XIRR입니다. 복수 해, 해 없음, 미수렴은 상태로 구분하며 임의의 0%를 표시하지 않습니다.</p></div><div><h3>기간 손익과 원가</h3><p>기간 손익 = 종료 평가액 − 시작 평가액 − 기간 순입금. 실현 원가는 {data.user.costMethod === "FIFO" ? "선입선출(FIFO)" : "이동평균(AVERAGE)"} 방식입니다. 보유분의 미실현 손익은 전체 매입 원가 기준으로 기간 손익과 다릅니다.</p></div><div><h3>최대 낙폭 (MDD)</h3><p>입출금 효과를 분리한 성과 흐름에서 고점 대비 가장 큰 하락을 보여줍니다. 환산 수익에는 가격 변화와 환율 효과가 함께 포함됩니다.</p></div></div></details>
    <Panel title="일별 성과 데이터" description="가격 기준 비교는 ‘배당 제외 TWR’와 ‘벤치마크 PRICE’ 열을 사용합니다. 배당 포함 총수익은 별도 열입니다."><TableWrap><table><thead><tr><th>날짜</th><th className="numeric">평가액</th><th className="numeric">누적 순입금</th><th className="numeric">외부 현금흐름</th><th className="numeric">기간 누적 손익</th><th className="numeric">총수익 TWR (배당 포함)</th><th className="numeric">배당 제외 TWR</th><th className="numeric">벤치마크 PRICE</th></tr></thead><tbody>{rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((point) => <tr key={point.date}><td>{point.date}</td><td className="numeric">{money(point.value, filters.currency)}</td><td className="numeric">{money(point.netContributions, filters.currency)}</td><td className="numeric">{money(point.externalFlow, filters.currency)}</td><td className={`numeric ${tone(point.profit)}`}>{money(point.profit, filters.currency)}</td><td className={`numeric ${tone(point.twr)}`}>{percent(point.twr)}</td><td className={`numeric ${tone(point.portfolioPriceTwr)}`}>{percent(point.portfolioPriceTwr)}</td><td className="numeric">{percent(point.benchmarkReturn)}</td></tr>)}</tbody></table></TableWrap>{!rows.length && <EmptyState description="선택 기간에 계산할 데이터가 없습니다." />}<div className="pagination"><span>{rows.length}일 · {currentPage + 1} / {Math.max(1, Math.ceil(rows.length / pageSize))} 페이지</span><div><Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>이전</Button><Button variant="outline" size="sm" disabled={(currentPage + 1) * pageSize >= rows.length} onClick={() => setPage(currentPage + 1)}>다음</Button></div></div></Panel>
  </div>;
}
