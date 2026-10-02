"use client";

import { useState, type FormEvent } from "react";
import { ArrowRightLeft, ChevronDown, FileUp, Plus, RefreshCw } from "lucide-react";
import type { Currency } from "@/lib/domain";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, ErrorNotice, SubmitButton } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/input";
import { request, useMutation } from "./api";
import { dateTime, unitMoney as money, quantity, today } from "./format";
import { Hint, Panel, TableWrap } from "./shared";
import { useWorkspace } from "./workspace-context";
import { MarketCsvImport } from "./market-import";

function sourceLabel(source: string | null) {
  return source === "FRANKFURTER" ? "ECB 기준 환율 · via Frankfurter" : source ?? "자료 없음";
}

export function MarketSettings() {
  const { data, filters } = useWorkspace();
  const [dialog, setDialog] = useState<"price" | "bulk" | "fx" | "fx-bulk" | null>(null);
  const [assetFilter, setAssetFilter] = useState("all");
  const [pricePage, setPricePage] = useState(0);
  const prices = data.marketData.prices.filter((price) => price.date >= filters.from && price.date <= filters.to && (assetFilter === "all" || price.assetId === assetFilter)).sort((left, right) => right.date.localeCompare(left.date));
  const fx = data.marketData.fx.filter((rate) => rate.date >= filters.from && rate.date <= filters.to).sort((left, right) => right.date.localeCompare(left.date));
  const currentPage = Math.min(pricePage, Math.max(0, Math.ceil(prices.length / 20) - 1));
  return <div className="view-stack"><RefreshSettings />
    <Panel title="종가 관측 데이터" description="상단 기간 내 원시 종가(RAW)입니다. 수집 시점과 출처를 확인하세요." action={<div className="button-row"><Button variant="outline" size="sm" onClick={() => setDialog("bulk")}><FileUp />가격 CSV 가져오기</Button><Button size="sm" onClick={() => setDialog("price")}><Plus />가격 입력</Button></div>}>
      <div className="table-toolbar"><Select value={assetFilter} aria-label="가격 종목 필터" onChange={(event) => { setAssetFilter(event.target.value); setPricePage(0); }}><option value="all">전체 종목</option>{data.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} ({asset.symbol})</option>)}</Select><span className="text-muted text-sm">{prices.length}개 관측치</span></div>
      {!prices.length ? <EmptyState title="표시할 가격 관측치가 없어요" description="기간을 확인하거나 종가를 직접 입력하세요. 가격이 없는 자산은 0원으로 평가하지 않습니다." /> : <><TableWrap><table><thead><tr><th>종목</th><th>가격 기준일</th><th className="numeric">종가</th><th>출처</th><th>수집 시각</th></tr></thead><tbody>{prices.slice(currentPage * 20, (currentPage + 1) * 20).map((price) => <tr key={price.id}><td>{data.assets.find((asset) => asset.id === price.assetId)?.name ?? price.assetId}</td><td>{price.date}</td><td className="numeric">{money(price.close, price.currency)}<small className="cell-sub">{price.currency} · RAW</small></td><td><span className="badge">{price.source}</span></td><td>{dateTime(price.fetchedAt)}</td></tr>)}</tbody></table></TableWrap><div className="pagination"><span>{currentPage + 1} / {Math.max(1, Math.ceil(prices.length / 20))} 페이지</span><div><Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPricePage(currentPage - 1)}>이전 가격</Button><Button variant="outline" size="sm" disabled={(currentPage + 1) * 20 >= prices.length} onClick={() => setPricePage(currentPage + 1)}>다음 가격</Button></div></div></>}
    </Panel>
    <Panel title="환율 관측 데이터" description="1 기준 통화 = 입력 환율 × 상대 통화" action={<div className="button-row"><Button variant="outline" size="sm" onClick={() => setDialog("fx-bulk")}><FileUp />환율 CSV 가져오기</Button><Button size="sm" onClick={() => setDialog("fx")}><ArrowRightLeft />환율 입력</Button></div>}>
      {!fx.length ? <EmptyState title="기간 내 환율이 없어요" description="수동 환율을 입력하거나 Frankfurter를 통해 ECB 기준 환율을 수집하세요." /> : <details className="market-fx-details" open><summary>환율 {fx.length}개 관측치 <ChevronDown size={15} /></summary><TableWrap><table><thead><tr><th>기준일</th><th>통화쌍</th><th className="numeric">환율</th><th>출처</th><th>수집 시각</th></tr></thead><tbody>{fx.map((rate) => <tr key={rate.id}><td>{rate.date}</td><td>{rate.base} → {rate.quote}</td><td className="numeric">1 {rate.base} = {quantity(rate.rate)} {rate.quote}</td><td><span className="badge">{sourceLabel(rate.source)}</span></td><td>{dateTime(rate.fetchedAt)}</td></tr>)}</tbody></table></TableWrap></details>}
    </Panel>
    <ProvenancePanel />
    {dialog === "price" && <PriceEditor onClose={() => setDialog(null)} />}
    {dialog === "bulk" && <MarketCsvImport kind="PRICE" onClose={() => setDialog(null)} />}
    {dialog === "fx" && <FxEditor onClose={() => setDialog(null)} />}
    {dialog === "fx-bulk" && <MarketCsvImport kind="FX" onClose={() => setDialog(null)} />}
  </div>;
}

function RefreshSettings() {
  const { data, filters, refresh, notify } = useWorkspace();
  const [provider, setProvider] = useState("FRANKFURTER");
  const mutation = useMutation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const assetId = String(values.get("assetId") || "");
    await mutation.run(() => request<{ status?: string; message?: string; count?: number }>("/api/refresh", {
      method: "POST", body: JSON.stringify({ provider, from: filters.from, to: filters.to, ...(provider === "ALPHA_VANTAGE" && assetId ? { assetId } : {}) }),
    }), (result) => {
      notify(result.message || (result.status === "FAILED" ? "수집에 실패했습니다. 작업 이력을 확인하세요." : "수집 요청이 처리되었습니다. 작업 이력을 확인하세요."));
    });
    refresh();
  }
  return <Panel title="데이터 수집" description="자동으로 값을 만들지 않습니다. 원본 공급자의 가용성과 이용 권한을 확인하세요."><form onSubmit={submit} className="settings-form form-stack"><div className="form-grid"><Field label="데이터 제공자"><Select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="FRANKFURTER">Frankfurter · ECB 기준 환율</option><option value="ALPHA_VANTAGE">Alpha Vantage · 원시 종가, 권한 필요</option></Select></Field><Field label="수집 기간"><Input value={`${filters.from} ~ ${filters.to}`} readOnly aria-describedby="refresh-range-help" /></Field>{provider === "ALPHA_VANTAGE" && <Field label="수집 종목" className="full-width"><Select name="assetId" required><option value="">수집할 종목을 선택하세요</option>{data.assets.filter((asset) => asset.provider === "ALPHA_VANTAGE").map((asset) => <option value={asset.id} key={asset.id}>{asset.name} ({asset.symbol})</option>)}</Select></Field>}</div><p id="refresh-range-help" className="field-hint">수집 기간은 화면 상단의 공통 기간 필터에서 바꿀 수 있습니다.</p><Hint>{provider === "FRANKFURTER" ? "European Central Bank (ECB), via Frankfurter / ECB 기준 환율. ECB의 기준 환율을 Frankfurter를 통해 수집하며 데모 값으로 대체하지 않습니다. 실제 환전 체결가와 다르고 주말·휴일에는 새 관측치가 없을 수 있습니다. 주식·가상자산 가격은 제공하지 않습니다." : "Alpha Vantage는 서버 API 키뿐 아니라 이용 권한을 확인한 뒤 ALPHA_VANTAGE_LICENSE_ACK=true 설정이 필요한 선택적 기능입니다. NASDAQ·NYSE·AMEX의 USD 주식·ETF에 대해 최근 100개 일별 원시 종가만 지원하며, 호출 제한이 적용됩니다. 별도 서면 계약이 없다면 개인·비상업적 용도 범위에서 사용하세요. 배당 재투자 총수익은 제공하지 않습니다."}</Hint><p className="field-hint">국내 종목·가상자산·사용자 자산의 가격은 아래에서 직접 입력하거나 일괄 등록해 주세요.</p><ErrorNotice message={mutation.error} /><div className="form-actions"><SubmitButton pending={mutation.pending}><RefreshCw />선택 기간 데이터 새로고침</SubmitButton></div></form>
    <div className="subsection-heading"><h3>수집 작업 이력</h3><span>최근 요청과 실패 사유</span></div>{!data.jobs.length ? <EmptyState title="아직 실행한 수집 작업이 없어요" description="데이터 수집을 요청하면 진행 결과와 오류가 기록됩니다." /> : <TableWrap><table><thead><tr><th>제공자</th><th>기간</th><th>상태</th><th className="numeric">관측치</th><th>결과 / 오류</th><th>요청 시각</th></tr></thead><tbody>{data.jobs.map((job) => <tr key={job.id}><td>{job.provider}</td><td className="nowrap">{job.from}<small className="cell-sub">~ {job.to}</small></td><td><span className={`badge ${job.status === "FAILED" ? "badge-error" : ["COMPLETED", "SUCCESS", "SUCCEEDED"].includes(job.status) ? "badge-success" : "badge-warning"}`}>{({ FAILED: "실패", COMPLETED: "완료", SUCCESS: "완료", SUCCEEDED: "완료", RUNNING: "진행 중", PENDING: "대기 중", QUEUED: "대기 중" } as Record<string, string>)[job.status] || job.status}</span></td><td className="numeric">{job.count}</td><td className="memo-cell">{job.message || "—"}{job.errorCode && <small className="cell-sub text-negative">{job.errorCode}</small>}</td><td>{dateTime(job.startedAt)}</td></tr>)}</tbody></table></TableWrap>}
  </Panel>;
}

function PriceEditor({ onClose }: { onClose: () => void }) {
  const { data, filters, refresh, notify } = useWorkspace();
  const [assetId, setAssetId] = useState(data.assets[0]?.id ?? "");
  const asset = data.assets.find((item) => item.id === assetId);
  const mutation = useMutation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await mutation.run(() => request("/api/prices", { method: "POST", body: JSON.stringify({ assetId, date: String(values.get("date")), close: String(values.get("close")), currency: asset?.currency ?? "KRW" }) }), () => { notify("종가와 수동 입력 출처를 저장했습니다."); refresh(); onClose(); });
  }
  return <Dialog title="가격 직접 입력" description="같은 종목·날짜의 관측값은 갱신될 수 있습니다. 정확한 통화와 종가를 확인하세요." onClose={onClose}><form className="form-stack" onSubmit={submit}><Field label="가격 입력 종목" required><Select value={assetId} onChange={(event) => setAssetId(event.target.value)} required><option value="">종목 선택</option>{data.assets.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.symbol} · {item.currency})</option>)}</Select></Field><Field label="가격 기준일" required><Input name="date" type="date" defaultValue={filters.to || today()} required /></Field><Field label={`종가 (${asset?.currency ?? "—"})`} required><Input name="close" type="number" min="0" step="any" placeholder="0" required /></Field><Hint>이 입력은 시세 관측치입니다. 사용자 자산의 평가 변경을 원장에 기록하려면 거래 추가 → 사용자 자산 평가를 사용하세요.</Hint><ErrorNotice message={mutation.error} /><div className="form-actions"><Button variant="outline" onClick={onClose}>취소</Button><SubmitButton pending={mutation.pending} disabled={!assetId}>가격 저장하기</SubmitButton></div></form></Dialog>;
}

function FxEditor({ onClose }: { onClose: () => void }) {
  const { filters, refresh, notify } = useWorkspace();
  const [base, setBase] = useState<Currency>("USD");
  const quote = base === "USD" ? "KRW" : "USD";
  const mutation = useMutation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await mutation.run(() => request("/api/fx", { method: "POST", body: JSON.stringify({ date: String(values.get("date")), base, quote, rate: String(values.get("rate")) }) }), () => { notify("환율을 저장했습니다."); refresh(); onClose(); });
  }
  return <Dialog title="환율 직접 입력" description="실제 환전 거래와 평가에 사용하는 환율 관측치는 다릅니다." onClose={onClose}><form className="form-stack" onSubmit={submit}><Field label="환율 기준일" required><Input name="date" type="date" defaultValue={filters.to} required /></Field><Field label="환율 기준 통화"><Select value={base} onChange={(event) => setBase(event.target.value as Currency)}><option value="USD">USD · 미국 달러</option><option value="KRW">KRW · 원화</option></Select></Field><Field label={`환율 (1 ${base} = ? ${quote})`} required><Input name="rate" type="number" min="0.000000000001" step="any" placeholder={base === "USD" ? "예: 1350" : "예: 0.00074"} required /></Field><ErrorNotice message={mutation.error} /><div className="form-actions"><Button variant="outline" onClick={onClose}>취소</Button><SubmitButton pending={mutation.pending}>환율 저장하기</SubmitButton></div></form></Dialog>;
}

function ProvenancePanel() {
  const { data } = useWorkspace();
  const [page, setPage] = useState(0);
  const rows = [...data.analysis.provenance].sort((left, right) => right.asOf.localeCompare(left.asOf));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1));
  return <Panel title="계산에 사용된 데이터 출처" description="계산일과 실제 관측일은 다를 수 있습니다. 이전 값의 사용 여부까지 확인하세요."><TableWrap><table><thead><tr><th>계산 기준일</th><th>데이터</th><th>실제 관측일</th><th>출처</th><th>수집 시각</th><th>상태</th></tr></thead><tbody>{rows.slice(currentPage * 20, (currentPage + 1) * 20).map((row, index) => <tr key={`${row.kind}-${row.asOf}-${index}`}><td>{row.asOf}</td><td>{row.kind === "PRICE" ? data.assets.find((asset) => asset.id === row.assetId)?.symbol ?? "종가" : `${row.base}/${row.quote}`}</td><td>{row.observedOn ?? "자료 없음"}</td><td>{sourceLabel(row.source)}</td><td>{dateTime(row.fetchedAt)}</td><td><span className={`badge ${!row.usable ? "badge-error" : row.stale ? "badge-warning" : "badge-success"}`}>{!row.usable ? "사용 불가" : row.stale ? "오래된 데이터" : row.carried ? "이전 관측값 사용" : "유효"}</span>{row.ageDays !== null && <small className="cell-sub">{row.ageDays}일 경과</small>}</td></tr>)}</tbody></table></TableWrap>{!rows.length && <EmptyState description="계산에 필요한 시장 데이터가 아직 없습니다." />}<div className="pagination"><span>{rows.length}개 근거 · {currentPage + 1} / {Math.max(1, Math.ceil(rows.length / 20))} 페이지</span><div><Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>이전 출처</Button><Button variant="outline" size="sm" disabled={(currentPage + 1) * 20 >= rows.length} onClick={() => setPage(currentPage + 1)}>다음 출처</Button></div></div></Panel>;
}
