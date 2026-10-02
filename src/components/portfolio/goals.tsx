"use client";

import Decimal from "decimal.js";
import { useState, type FormEvent } from "react";
import { ArrowUpRight, Flag, Pencil, Plus, Target, Trash2 } from "lucide-react";
import type { GoalDto } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, ErrorNotice, SubmitButton } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/input";
import { request, useMutation } from "./api";
import { GoalChart } from "./charts";
import { DeleteDialog } from "./delete-dialog";
import { money, number, percent } from "./format";
import { Hint, Panel, StatList, TableWrap } from "./shared";
import { useWorkspace } from "./workspace-context";

export function Goals() {
  const { data } = useWorkspace();
  const [editing, setEditing] = useState<GoalDto | "new" | null>(null);
  const [removing, setRemoving] = useState<GoalDto | null>(null);
  return <div className="view-stack">
    <div className="welcome-banner goal-banner"><div><span className="eyebrow"><Flag size={14} /> A LITTLE CLOSER, EVERY DAY</span><h2>투자의 방향을 정하는 나만의 목표</h2><p>오늘의 실적과 내일의 가정을 나누어, 차근차근 목표에 가까워지세요.</p></div><Button onClick={() => setEditing("new")}><Plus />새 목표 만들기</Button></div>
    <Hint>실제 달성액은 상단의 기간·계좌·포트폴리오 필터를 적용해 각 목표 통화로 계산합니다. 예상 경로는 입력한 가정만 사용하며 실제 성과와 분리됩니다.</Hint>
    {!data.goals.length ? <Panel><EmptyState title="첫 번째 목표를 세워 볼까요?" description="자산 1억 원, 월 배당 100만 원처럼 원하는 목적지를 기록해 보세요." action={<Button onClick={() => setEditing("new")}><Target />목표 추가하기</Button>} /></Panel> : <div className="goal-grid">{data.goals.map((goal) => {
      const progress = number(goal.progress);
      return <Panel key={goal.id} className="goal-card" title={goal.name} description={`${goal.kind === "ASSET" ? "자산 목표" : "종료 월 세후 배당 목표"} · ${goal.currency}`} action={<div className="row-actions"><Button variant="ghost" size="icon" aria-label={`${goal.name} 목표 수정`} onClick={() => setEditing(goal)}><Pencil /></Button><Button variant="ghost" size="icon" aria-label={`${goal.name} 목표 삭제`} onClick={() => setRemoving(goal)}><Trash2 /></Button></div>}>
        <div className="goal-values"><div><span>필터 적용 실제 달성액</span><strong>{money(goal.actualValue, goal.currency)}</strong></div><span className="goal-progress-label">{percent(goal.progress)}</span></div>
        <div className="goal-progress" role="progressbar" aria-label={`${goal.name} 달성률`} aria-valuenow={progress === null ? undefined : Math.max(0, Math.min(100, progress * 100))} aria-valuetext={progress === null ? "계산할 데이터 부족" : percent(goal.progress)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.max(0, Math.min(100, (progress ?? 0) * 100))}%` }} /></div>
        <div className="goal-target"><span>목표 금액</span><strong>{money(goal.target, goal.currency)}</strong></div>
        <div className="goal-projection-label"><ArrowUpRight size={16} /><strong>가정 기반 자산 성장 시뮬레이션</strong><span>실제 수익 아님</span></div>
        <GoalChart goal={goal} />
        <StatList entries={[{ label: "시작 금액", value: money(goal.initial, goal.currency) }, { label: "매월 납입", value: money(goal.monthlyContribution, goal.currency) }, { label: "가정 연 수익률", value: percent(goal.annualReturn) }, { label: `${goal.years}년 후 예상 자산`, value: money(goal.projection.at(-1)?.value, goal.currency) }]} />
        {goal.kind === "DIVIDEND" && <p className="field-hint px-panel">실제 달성액은 선택 기간 안에서 종료 월에 수령한 세후 배당입니다. 위 그래프는 납입 자산의 성장 가정이며 배당 지급액 예측이 아닙니다.</p>}
        <details className="projection-details"><summary>연도별 가정 계산표</summary><TableWrap><table><thead><tr><th>기간</th><th className="numeric">누적 납입</th><th className="numeric">예상 자산</th></tr></thead><tbody>{goal.projection.map((point) => <tr key={point.year}><td>{point.year}년</td><td className="numeric">{money(point.contributions, goal.currency)}</td><td className="numeric">{money(point.value, goal.currency)}</td></tr>)}</tbody></table></TableWrap></details>
      </Panel>;
    })}</div>}
    <Hint>고정 수익률, 매월 동일 금액 납입을 가정한 단순 시뮬레이션입니다. 세금·수수료·물가·시장 변동은 반영하지 않습니다. 원금 손실이 발생할 수 있으며 목표 달성이나 수익을 보장하지 않습니다.</Hint>
    {editing && <GoalEditor goal={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    {removing && <DeleteDialog title="목표를 삭제할까요?" description={`‘${removing.name}’ 목표와 시뮬레이션 가정이 삭제됩니다. 거래 기록은 유지됩니다.`} url={`/api/goals/${removing.id}`} onClose={() => setRemoving(null)} />}
  </div>;
}

function GoalEditor({ goal, onClose }: { goal?: GoalDto; onClose: () => void }) {
  const { filters, refresh, notify } = useWorkspace();
  const mutation = useMutation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const text = (key: string) => String(values.get(key) ?? "").trim();
    const payload = { name: text("name"), kind: text("kind"), target: text("target"), currency: text("currency"), initial: text("initial"), monthlyContribution: text("monthlyContribution"), annualReturn: new Decimal(text("annualReturn")).div(100).toString(), years: Number(text("years")) };
    await mutation.run(() => request(`/api/goals${goal ? `/${goal.id}` : ""}`, { method: goal ? "PATCH" : "POST", body: JSON.stringify(payload) }), () => { notify("목표를 저장했습니다."); refresh(); onClose(); });
  }
  return <Dialog title={goal ? "목표 수정" : "새 목표 만들기"} description="실제 달성액은 기록에서, 예상 경로는 아래의 가정에서 계산합니다." onClose={onClose}><form onSubmit={submit} className="form-stack"><div className="form-grid">
    <Field label="목표 이름" required className="full-width"><Input name="name" defaultValue={goal?.name ?? ""} placeholder="예: 경제적 자유를 위한 첫 1억" maxLength={80} required /></Field>
    <Field label="목표 종류" required><Select name="kind" defaultValue={goal?.kind ?? "ASSET"}><option value="ASSET">자산 평가액</option><option value="DIVIDEND">종료 월 세후 배당</option></Select></Field>
    <Field label="목표 통화" required><Select name="currency" defaultValue={goal?.currency ?? filters.currency}><option value="KRW">KRW · 원화</option><option value="USD">USD · 달러</option></Select></Field>
    <Field label="목표 금액" required className="full-width"><Input name="target" type="number" min="0.01" step="any" defaultValue={goal?.target ?? ""} required /></Field>
    <Field label="시뮬레이션 시작 금액" required><Input name="initial" type="number" min="0" step="any" defaultValue={goal?.initial ?? "0"} required /></Field>
    <Field label="매월 납입액" required><Input name="monthlyContribution" type="number" min="0" step="any" defaultValue={goal?.monthlyContribution ?? "0"} required /></Field>
    <Field label="가정 연 수익률 (%)" required><Input name="annualReturn" type="number" min="-99.9" max="100" step="any" defaultValue={goal ? new Decimal(goal.annualReturn).times(100).toString() : "6"} required /></Field>
    <Field label="시뮬레이션 기간 (년)" required><Input name="years" type="number" min="1" max="60" step="1" defaultValue={goal?.years ?? 10} required /></Field>
  </div><ErrorNotice message={mutation.error} /><div className="form-actions"><Button variant="outline" onClick={onClose}>취소</Button><SubmitButton pending={mutation.pending}>목표 저장하기</SubmitButton></div></form></Dialog>;
}
