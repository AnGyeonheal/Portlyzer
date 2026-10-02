"use client";

import Decimal from "decimal.js";
import { useState, type FormEvent } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, ErrorNotice, SubmitButton } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/input";
import { allocationRows, dimensions, type Dimension } from "./allocation-data";
import { request, useMutation } from "./api";
import { AllocationDonut } from "./charts";
import { DeleteDialog } from "./delete-dialog";
import { assetClassLabels, colors, money, percent, sum, tone } from "./format";
import { Hint, Panel, TableWrap } from "./shared";
import { useWorkspace } from "./workspace-context";

export function Allocation() {
  const { data, filters } = useWorkspace();
  const [dimension, setDimension] = useState<Dimension>("assetClass");
  const [editing, setEditing] = useState<{ key?: string; percent?: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const rows = allocationRows(data, dimension);
  const targetTotal = sum(data.targets.filter((target) => target.dimension === dimension).map((target) => target.percent));
  return <div className="view-stack">
    <div className="view-controls"><div className="segmented segmented-wrap" role="group" aria-label="자산 배분 기준">{Object.entries(dimensions).map(([key, label]) => <button key={key} className={dimension === key ? "active" : ""} onClick={() => setDimension(key as Dimension)}>{label}</button>)}</div><Button onClick={() => setEditing({})}><Plus />목표 비중 설정</Button></div>
    <div className="allocation-layout"><Panel title={`${dimensions[dimension]}별 자산 구성`} description="현금 포함 · 현재 필터 기준"><AllocationDonut data={rows} currency={filters.currency} total={data.analysis.summary.totalValue} /><div className="allocation-legend">{rows.map((row, index) => <div key={row.key}><span><i style={{ background: colors[index % colors.length] }} />{row.name}</span><strong>{percent(row.weight)}</strong></div>)}</div></Panel>
      <Panel title="목표와 현재 사이" description={`설정된 목표 합계 ${targetTotal ?? "—"}% · 목표 차이는 현재 − 목표`}>
        {!rows.length ? <EmptyState title="아직 비교할 자산이 없어요" description="거래를 기록하거나 목표 비중을 먼저 설정해 보세요." /> : <TableWrap><table><thead><tr><th>{dimensions[dimension]}</th><th className="numeric">평가액</th><th className="numeric">현재</th><th className="numeric">목표</th><th className="numeric">차이</th><th className="numeric">참고 조정액</th><th>관리</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.key}><td><span className="legend-name"><i style={{ background: colors[index % colors.length] }} />{row.name}</span></td><td className="numeric">{money(row.value, filters.currency)}</td><td className="numeric">{percent(row.weight)}</td><td className="numeric">{percent(row.target)}</td><td className={`numeric ${tone(row.difference)}`}>{row.difference === null ? "—" : `${new Decimal(row.difference).times(100).toFixed(2)}%p`}</td><td className="numeric">{money(row.rebalance, filters.currency)}<small className="cell-sub">{row.rebalance === null ? "목표 미설정" : new Decimal(row.rebalance).gt(0) ? "추가 배분 참고" : new Decimal(row.rebalance).lt(0) ? "축소 배분 참고" : "목표와 동일"}</small></td><td><div className="row-actions"><Button variant="ghost" size="icon" aria-label={`${row.name} 목표 비중 수정`} onClick={() => setEditing({ key: row.key, percent: row.target === null ? undefined : new Decimal(row.target).times(100).toString() })}><Pencil /></Button>{row.targetId && <Button variant="ghost" size="icon" aria-label={`${row.name} 목표 비중 삭제`} onClick={() => setRemoving(row.targetId!)}><Trash2 /></Button>}</div></td></tr>)}</tbody></table></TableWrap>}
      </Panel></div>
    {targetTotal !== null && targetTotal !== "0" && !new Decimal(targetTotal).equals(100) && <Hint>목표 비중의 합계가 100%가 아닙니다. 미설정 항목까지 확인해 주세요. 서로 다른 배분 기준의 목표는 독립적으로 관리됩니다.</Hint>}
    <Hint>참고 조정액 = 전체 평가액 × 목표 비중 − 현재 평가액. 거래 비용·세금·최소 주문 수량은 반영하지 않은 단순 안내이며 주문이나 투자 권유가 아닙니다. 가격·환율이 누락되면 금액을 제시하지 않습니다. 원형 차트는 양수의 평가액만 표시합니다.</Hint>
    {editing && <TargetEditor dimension={dimension} initial={editing} onClose={() => setEditing(null)} />}
    {removing && <DeleteDialog title="목표 비중을 삭제할까요?" description="실제 보유 자산이나 거래 기록은 변경되지 않습니다." url={`/api/targets/${removing}`} onClose={() => setRemoving(null)} />}
  </div>;
}

function TargetEditor({ dimension, initial, onClose }: { dimension: Dimension; initial: { key?: string; percent?: string }; onClose: () => void }) {
  const { data, refresh, notify } = useWorkspace();
  const mutation = useMutation();
  const options = new Map(allocationRows(data, dimension).map((row) => [row.key, row.name]));
  if (dimension === "asset") for (const asset of data.assets) options.set(asset.id, asset.name);
  if (dimension === "account") for (const account of data.accounts) options.set(account.id, account.name);
  if (dimension === "assetClass") for (const [key, label] of Object.entries(assetClassLabels)) options.set(key, label);
  if (dimension === "currency") { options.set("KRW", "KRW"); options.set("USD", "USD"); }
  const [custom, setCustom] = useState(options.size === 0);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await mutation.run(() => request("/api/targets", { method: "POST", body: JSON.stringify({ dimension, key: String(values.get("key")).trim(), percent: String(values.get("percent")) }) }), () => { notify("목표 비중을 저장했습니다."); refresh(); onClose(); });
  }
  return <Dialog title="목표 비중 설정" description={`${dimensions[dimension]} 기준 · 동일 항목의 목표는 갱신됩니다.`} onClose={onClose}><form className="form-stack" onSubmit={submit}><Field label={`${dimensions[dimension]} 항목`} required>{custom ? <Input name="key" defaultValue={initial.key} required placeholder="분류에 사용된 정확한 이름" /> : <Select name="key" defaultValue={initial.key ?? ""} required><option value="">항목 선택</option>{[...options].map(([key, label]) => <option value={key} key={key}>{label}</option>)}</Select>}</Field>{["country", "sector"].includes(dimension) && <Button variant="ghost" size="sm" onClick={() => setCustom(!custom)}>{custom ? "기존 항목 선택" : "새 분류 이름 입력"}</Button>}<Field label="목표 비중 (%)" required><Input name="percent" type="number" min="0" max="100" step="any" defaultValue={initial.percent ?? ""} placeholder="예: 30" required /></Field><ErrorNotice message={mutation.error} /><div className="form-actions"><Button variant="outline" onClick={onClose}>취소</Button><SubmitButton pending={mutation.pending}>목표 저장</SubmitButton></div></form></Dialog>;
}
