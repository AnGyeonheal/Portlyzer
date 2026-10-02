"use client";

import { useState, type FormEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, CircleDollarSign, Pencil, Plus, Trash2 } from "lucide-react";
import type { DividendUpcoming } from "@/lib/contracts";
import type { Currency } from "@/lib/domain";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, ErrorNotice, SubmitButton } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { request, useMutation } from "./api";
import { DividendChart } from "./charts";
import { DeleteDialog } from "./delete-dialog";
import { money, quantity, sum, today } from "./format";
import { AssetName, Hint, Metric, Panel, TableWrap } from "./shared";
import { TransactionEditor } from "./transaction-editor";
import { useWorkspace } from "./workspace-context";

export function Dividends() {
  const { data, filters } = useWorkspace();
  const [group, setGroup] = useState<"monthly" | "yearly" | "byAsset">("monthly");
  const [editing, setEditing] = useState<DividendUpcoming | "new" | null>(null);
  const [removing, setRemoving] = useState<DividendUpcoming | null>(null);
  const [receipt, setReceipt] = useState(false);
  const aggregate = data.dividends[group].map((row) => ({ ...row, key: group === "byAsset" ? data.assets.find((asset) => asset.id === row.key)?.symbol ?? (row.key || "미지정") : row.key }));
  const announced = data.dividends.upcoming.filter((event) => event.status === "ANNOUNCED" && !event.reconciled);
  const estimated = data.dividends.upcoming.filter((event) => event.status === "ESTIMATED" && !event.reconciled);
  return <div className="view-stack">
    <div className="metric-grid metric-grid-three"><Metric label="실제 수령한 세후 배당" value={money(sum(data.dividends.actual.map((item) => item.netBase)), filters.currency)} detail={`선택 기간 · ${data.dividends.actual.length}건`} featured icon={<CircleDollarSign size={18} />} /><Metric label="공시된 예상 배당" value={money(sum(announced.map((item) => item.expectedGrossBase)), filters.currency)} detail={`미대조 일정 ${announced.length}건 · 세전`} /><Metric label="가정에 따른 추정 배당" value={money(sum(estimated.map((item) => item.expectedGrossBase)), filters.currency)} detail={`미대조 일정 ${estimated.length}건 · 지급 보장 아님`} /></div>
    <Hint><strong>실제 수령 조회: {filters.from} ~ {filters.to}</strong><br /><strong>예상 일정 기준일: {filters.to}</strong> · 기준일까지 대조되지 않은 과거 지급 일정과 이후 12개월의 공시·추정 일정을 함께 보여줍니다. 예상 일정의 범위는 실제 수령 조회 기간과 다르며, 지급일 미정은 날짜를 대신 넣지 않고 별도로 표시합니다.</Hint>
    <div className="dividend-top-grid"><Panel title="차곡차곡 쌓이는 배당" description={`실제 수령액 · ${filters.currency} 환산 기준`} action={<div className="segmented" role="group" aria-label="배당 집계 기준"><button className={group === "monthly" ? "active" : ""} onClick={() => setGroup("monthly")}>월별</button><button className={group === "yearly" ? "active" : ""} onClick={() => setGroup("yearly")}>연도별</button><button className={group === "byAsset" ? "active" : ""} onClick={() => setGroup("byAsset")}>종목별</button></div>}><DividendChart rows={aggregate} currency={filters.currency} /><TableWrap><table><thead><tr><th>{group === "monthly" ? "월" : group === "yearly" ? "연도" : "종목"}</th><th className="numeric">세전</th><th className="numeric">세금</th><th className="numeric">세후</th></tr></thead><tbody>{aggregate.map((row, index) => <tr key={`${row.key}-${index}`}><td>{row.key}</td><td className="numeric">{money(row.gross, filters.currency)}</td><td className="numeric">{money(row.tax, filters.currency)}</td><td className="numeric">{money(row.net, filters.currency)}</td></tr>)}</tbody></table></TableWrap></Panel><DividendCalendar /></div>
    <Panel title="배당 일정" description={`${filters.to} 기준 · 미대조 과거 일정 + 이후 12개월 · 공시·추정·지급일 미정 구분`} action={<Button size="sm" onClick={() => setEditing("new")}><Plus />배당 일정 추가</Button>}>
      {!data.dividends.upcoming.length ? <EmptyState title="다가올 배당을 기록해 보세요" description="공시 출처와 기준일을 남기거나, 추정 근거를 함께 적어 두세요." /> : <TableWrap><table><thead><tr><th>종목</th><th>상태 / 대조</th><th>배당락일 / 기준일</th><th>지급일</th><th className="numeric">주당 배당</th><th className="numeric">대상 수량</th><th className="numeric">예상 세전 금액</th><th>출처 / 근거</th><th>관리</th></tr></thead><tbody>{data.dividends.upcoming.map((event) => <tr key={event.id}><td><AssetName asset={data.assets.find((asset) => asset.id === event.assetId)} /></td><td><span className={`badge ${event.status === "ANNOUNCED" ? "badge-info" : "badge-warning"}`}>{event.status === "ANNOUNCED" ? "공시" : "추정"}</span><small className="cell-sub">{event.reconciled ? "수령 대조 완료" : `연결 수령 ${money(event.receivedGross, event.currency)}`}</small></td><td className="nowrap">{event.exDate || "미정"}<small className="cell-sub">기준일 {event.recordDate || "미정"}</small></td><td className="nowrap">{event.payDate || <span className="badge badge-warning">지급일 미정</span>}</td><td className="numeric">{money(event.amountPerShare, event.currency)}</td><td className="numeric">{quantity(event.eligibleQuantity)}</td><td className="numeric">{money(event.expectedGrossBase, filters.currency)}<small className="cell-sub">{money(event.expectedGross, event.currency)}</small>{event.missing.length > 0 && <small className="cell-sub text-amber-700">{event.missing.join(" · ")}</small>}</td><td className="memo-cell">{event.source}<small className="cell-sub">기준 {event.asOf}</small><details><summary>산정 근거</summary><p>{event.basis || "별도 근거 없음"}</p></details></td><td><div className="row-actions"><Button variant="ghost" size="icon" aria-label={`${data.assets.find((asset) => asset.id === event.assetId)?.symbol} 배당 일정 수정`} onClick={() => setEditing(event)}><Pencil /></Button><Button variant="ghost" size="icon" aria-label="배당 일정 삭제" onClick={() => setRemoving(event)}><Trash2 /></Button></div></td></tr>)}</tbody></table></TableWrap>}
    </Panel>
    <Panel title="실제 배당 수령 내역" description="예상 금액이 아니라 거래 원장에 기록된 실제 현금입니다." action={<Button size="sm" onClick={() => setReceipt(true)}><Plus />배당 수령 기록</Button>}>
      {!data.dividends.actual.length ? <EmptyState description="배당 거래를 기록하면 세전·세금·세후 금액을 확인할 수 있습니다." /> : <TableWrap><table><thead><tr><th>수령일</th><th>종목 / 계좌</th><th className="numeric">세전 금액</th><th className="numeric">세금</th><th className="numeric">세후 금액</th><th className="numeric">세후 환산 ({filters.currency})</th><th>일정 연결</th></tr></thead><tbody>{data.dividends.actual.map((item) => <tr key={item.transactionId}><td>{item.date}</td><td>{item.assetId ? <AssetName asset={data.assets.find((asset) => asset.id === item.assetId)} /> : "미지정"}<small className="cell-sub">{data.accounts.find((account) => account.id === item.accountId)?.name}</small></td><td className="numeric">{money(item.gross, item.currency)}</td><td className="numeric">{money(item.tax, item.currency)}</td><td className="numeric">{money(item.net, item.currency)}</td><td className="numeric font-semibold">{money(item.netBase, filters.currency)}</td><td><span className={`badge ${item.eventId ? "badge-success" : "badge-neutral"}`}>{item.eventId ? "일정 연결됨" : "미연결"}</span></td></tr>)}</tbody></table></TableWrap>}
    </Panel>
    <Hint>미래 배당은 공시 또는 사용자의 추정치로 지급을 보장하지 않습니다. 대상 수량은 배당 기준과 보유 기록으로 계산합니다. 지급일이 알려지지 않은 일정은 달력에 임의 배치하지 않으며, 배당락일로 대체하지 않습니다.</Hint>
    {editing && <DividendEditor item={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}
    {removing && <DeleteDialog title="배당 일정을 삭제할까요?" description="공시·추정 일정만 삭제됩니다. 실제 수령 거래는 원장에 유지됩니다." url={`/api/dividends/${removing.id}`} onClose={() => setRemoving(null)} />}
    {receipt && <TransactionEditor defaultKind="DIVIDEND" onClose={() => setReceipt(false)} />}
  </div>;
}

function DividendCalendar() {
  const { data, filters } = useWorkspace();
  const [month, setMonth] = useState(filters.to.slice(0, 7));
  const [selected, setSelected] = useState<string | null>(null);
  const horizonDate = new Date(`${filters.to}T00:00:00Z`);
  horizonDate.setUTCDate(horizonDate.getUTCDate() + 366);
  const horizon = horizonDate.toISOString().slice(0, 7);
  const calendarStart = data.dividends.upcoming.reduce((earliest, event) => {
    const eventMonth = event.payDate?.slice(0, 7);
    return eventMonth && eventMonth < earliest ? eventMonth : earliest;
  }, filters.from.slice(0, 7));
  const activeMonth = month < calendarStart || month > horizon ? filters.to.slice(0, 7) : month;
  const [year, monthNumber] = activeMonth.split("-").map(Number);
  const first = new Date(year, monthNumber - 1, 1).getDay();
  const days = new Date(year, monthNumber, 0).getDate();
  const events = [
    ...data.dividends.upcoming.filter((event) => event.payDate).map((event) => ({ id: event.id, date: event.payDate!, assetId: event.assetId, status: event.status, amount: event.expectedGrossBase })),
    ...data.dividends.actual.map((event) => ({ id: event.transactionId, date: event.date, assetId: event.assetId, status: "ACTUAL", amount: event.netBase })),
  ];
  const picked = events.filter((event) => event.date === selected);
  const unknown = data.dividends.upcoming.filter((event) => !event.payDate);
  function changeMonth(delta: number) {
    const date = new Date(year, monthNumber - 1 + delta, 1);
    setMonth(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
    setSelected(null);
  }
  return <Panel title="배당 캘린더" description={`지급일 기준 · ${filters.to} 현재의 과거 미대조 및 이후 12개월 일정`} action={<CalendarDays size={18} className="text-muted" />}><div className="calendar-toolbar"><Button variant="ghost" size="icon" aria-label="이전 배당 월" onClick={() => changeMonth(-1)} disabled={activeMonth <= calendarStart}><ChevronLeft /></Button><strong>{year}년 {monthNumber}월</strong><Button variant="ghost" size="icon" aria-label="다음 배당 월" onClick={() => changeMonth(1)} disabled={activeMonth >= horizon}><ChevronRight /></Button></div><div className="calendar-grid">{["일", "월", "화", "수", "목", "금", "토"].map((day) => <span className="calendar-weekday" key={day}>{day}</span>)}{Array.from({ length: first }, (_, index) => <span key={`blank-${index}`} />)}{Array.from({ length: days }, (_, index) => {
    const date = `${activeMonth}-${String(index + 1).padStart(2, "0")}`;
    const items = events.filter((event) => event.date === date);
    return <button className={`${selected === date ? "selected" : ""} ${date === today() ? "is-today" : ""}`} key={date} onClick={() => setSelected(date)} aria-label={`${date} 배당 ${items.length}건`} aria-pressed={selected === date}><span>{index + 1}</span><span className="calendar-dots">{[...new Set(items.map((item) => item.status))].map((status) => <i key={status} className={`calendar-${status.toLowerCase()}`} />)}</span></button>;
  })}</div><div className="calendar-legend"><span><i className="calendar-actual" />실제</span><span><i className="calendar-announced" />공시</span><span><i className="calendar-estimated" />추정</span></div>{selected && <div className="calendar-selection"><strong>{selected}</strong>{!picked.length ? <p>이 날짜에 등록된 지급·수령 내역이 없습니다.</p> : picked.map((item) => <div key={item.id}><span>{data.assets.find((asset) => asset.id === item.assetId)?.name ?? "미지정"}<small>{item.status === "ACTUAL" ? "실제 세후" : item.status === "ANNOUNCED" ? "공시 세전" : "추정 세전"}</small></span><strong>{money(item.amount, filters.currency)}</strong></div>)}</div>}{unknown.length > 0 && <div className="calendar-unknown"><span className="badge badge-warning">지급일 미정 {unknown.length}건</span><p>아래 일정 표에서 확인하세요. 배당락일로 대체하지 않습니다.</p></div>}</Panel>;
}

function DividendEditor({ item, onClose }: { item?: DividendUpcoming; onClose: () => void }) {
  const { data, refresh, notify } = useWorkspace();
  const [assetId, setAssetId] = useState(item?.assetId ?? data.assets[0]?.id ?? "");
  const [currency, setCurrency] = useState<Currency>(item?.currency ?? data.assets.find((asset) => asset.id === assetId)?.currency ?? "KRW");
  const mutation = useMutation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const text = (field: string) => String(values.get(field) ?? "").trim();
    const payload = { assetId, currency, status: text("status"), exDate: text("exDate") || null, recordDate: text("recordDate") || null, payDate: text("payDate") || null, amountPerShare: text("amountPerShare"), source: text("source"), basis: text("basis"), asOf: text("asOf") };
    await mutation.run(() => request(`/api/dividends${item ? `/${item.id}` : ""}`, { method: item ? "PATCH" : "POST", body: JSON.stringify(payload) }), () => { notify("배당 일정을 저장했습니다."); refresh(); onClose(); });
  }
  return <Dialog title={item ? "배당 일정 수정" : "배당 일정 추가"} description="공시 사실과 추정을 구분하고, 확인할 수 없는 날짜는 비워 두세요." onClose={onClose} wide><form className="form-stack" onSubmit={submit}><div className="form-grid">
    <Field label="배당 종목" required><Select value={assetId} onChange={(event) => { setAssetId(event.target.value); setCurrency(data.assets.find((asset) => asset.id === event.target.value)?.currency ?? "KRW"); }} required><option value="">종목 선택</option>{data.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} ({asset.symbol})</option>)}</Select></Field>
    <Field label="일정 상태" required><Select name="status" defaultValue={item?.status ?? "ANNOUNCED"}><option value="ANNOUNCED">공시 · 출처에서 확인</option><option value="ESTIMATED">추정 · 가정에 기반</option></Select></Field>
    <Field label="주당 배당금" required><Input name="amountPerShare" type="number" step="any" min="0.000000000001" defaultValue={item?.amountPerShare ?? ""} required /></Field>
    <Field label="배당 통화" required><Select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}><option value="KRW">KRW</option><option value="USD">USD</option></Select></Field>
    <Field label="배당락일"><Input name="exDate" type="date" defaultValue={item?.exDate ?? ""} /></Field>
    <Field label="배당 기준일"><Input name="recordDate" type="date" defaultValue={item?.recordDate ?? ""} /></Field>
    <Field label="지급일" hint="알 수 없으면 비워 두세요."><Input name="payDate" type="date" defaultValue={item?.payDate ?? ""} /></Field>
    <Field label="정보 확인 기준일" required><Input name="asOf" type="date" defaultValue={item?.asOf?.slice(0, 10) ?? today()} max={today()} required /></Field>
    <Field label="출처" required className="full-width"><Input name="source" defaultValue={item?.source ?? ""} placeholder="예: 기업 공시 URL 또는 공시 제목" maxLength={200} required /></Field>
    <Field label="산정 근거" required className="full-width"><Textarea name="basis" defaultValue={item?.basis ?? ""} placeholder="예: 2026년 분기배당 공시 / 직전 배당 유지 가정" required maxLength={500} /></Field>
  </div><ErrorNotice message={mutation.error} /><div className="form-actions"><Button variant="outline" onClick={onClose}>취소</Button><SubmitButton pending={mutation.pending} disabled={!assetId}>일정 저장하기</SubmitButton></div></form></Dialog>;
}
