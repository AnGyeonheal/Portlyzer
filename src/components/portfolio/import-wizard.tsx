"use client";

import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, Download, FileCheck2, FileUp, UploadCloud, X } from "lucide-react";
import { importFields, type ImportField, type ImportMapping, type ImportUploadResult, type ImportValidationResult } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import { ErrorNotice, SubmitButton } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/input";
import { request, useMutation } from "./api";
import { kindLabels } from "./format";
import { Hint, Panel, TableWrap } from "./shared";
import { useWorkspace } from "./workspace-context";

const labels: Record<ImportField | "dividendEventId" | "duplicate", string> = {
  date: "거래일", kind: "거래 유형", symbol: "종목 코드", exchange: "거래소", currency: "통화",
  quantity: "수량", price: "단가", amount: "금액", fee: "수수료", tax: "세금",
  toAccountId: "받는 계좌 ID", toCurrency: "도착 통화", toAmount: "환전 입금액",
  ratio: "분할 비율", memo: "메모", tags: "태그", sourceTransactionId: "원본 거래 ID",
  dividendEventId: "배당 일정", duplicate: "중복 선택",
};
const stepNames = ["파일 업로드", "필드 연결", "검증·수정", "미리보기", "반영 완료"];

export function ImportWizard({ onClose }: { onClose: () => void }) {
  const { data, filters, refresh, notify } = useWorkspace();
  const [step, setStep] = useState(0);
  const [upload, setUpload] = useState<ImportUploadResult | null>(null);
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [validation, setValidation] = useState<ImportValidationResult | null>(null);
  const [changes, setChanges] = useState<Record<string, Record<string, string>>>({});
  const [decisions, setDecisions] = useState<Record<string, "KEEP" | "SKIP">>({});
  const [dirty, setDirty] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [confirmedCount, setConfirmedCount] = useState(0);
  const mutation = useMutation();

  async function uploadFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const file = values.get("file");
    if (!(file instanceof File) || !file.size) { mutation.setError("가져올 파일을 선택해 주세요."); return; }
    if (file.size > 2 * 1024 * 1024) { mutation.setError("파일 크기는 2 MiB 이하여야 합니다."); return; }
    if (!/\.(csv|xlsx)$/i.test(file.name)) { mutation.setError("CSV 또는 XLSX 파일만 지원합니다."); return; }
    await mutation.run(() => request<ImportUploadResult>("/api/imports/upload", { method: "POST", body: values }), (result) => {
      setUpload(result);
      const proposed: ImportMapping = {};
      for (const field of importFields) {
        const header = result.headers.find((name) => name.trim().toLowerCase() === field.toLowerCase() || name.trim() === labels[field]);
        if (header) proposed[field] = header;
      }
      setMapping(proposed);
      setStep(1);
    });
  }

  async function validate() {
    if (!upload) return;
    await mutation.run(() => request<ImportValidationResult>(`/api/imports/${upload.jobId}/validate`, {
      method: "POST",
      body: JSON.stringify({ revision: validation?.revision ?? upload.revision, mapping, changes, decisions }),
    }), (result) => { setValidation(result); setStep(2); setDirty(false); setPage(0); setExpanded(result.rows.find((row) => row.errors.length)?.rowNumber ?? null); });
  }

  async function confirm() {
    if (!upload || !validation || !validation.valid || dirty) return;
    await mutation.run(() => request(`/api/imports/${upload.jobId}/confirm`, { method: "POST", body: JSON.stringify({ revision: validation.revision }) }), () => {
      setConfirmedCount(validation.summary.keep);
      setStep(4);
      notify(`${validation.summary.keep}건의 거래를 가져왔습니다.`);
      refresh();
    });
  }

  return <Panel title="거래 파일 가져오기" description="직접 열을 연결하는 일반 CSV·XLSX 가져오기입니다. 특정 증권사 전용 파서는 제공하지 않습니다." action={<Button variant="ghost" size="icon" aria-label="가져오기 닫기" onClick={onClose} disabled={mutation.pending}><X /></Button>} className="import-wizard">
    <ol className="import-steps" aria-label="가져오기 단계">{stepNames.map((name, index) => <li key={name} className={step === index ? "active" : step > index ? "complete" : ""} aria-current={step === index ? "step" : undefined}><span>{step > index ? <Check size={14} /> : index + 1}</span><strong>{name}</strong></li>)}</ol>
    <div className="import-content">
      {step === 0 && <form className="form-stack" onSubmit={uploadFile}>
        <div className="upload-zone"><UploadCloud size={38} /><h3>기록의 시작은 파일 하나로</h3><p>최대 2 MiB · .csv 또는 .xlsx · 날짜는 YYYY-MM-DD</p><Field label="거래 파일" required><Input name="file" type="file" accept=".csv,.xlsx" required disabled={mutation.pending} /></Field></div>
        <Field label="가져올 계좌" required><Select name="accountId" defaultValue={filters.accountId !== "all" ? filters.accountId : data.accounts[0]?.id ?? ""} required><option value="">계좌를 선택하세요</option>{data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}</Select></Field>
        {!data.accounts.length && <Hint>설정에서 계좌를 먼저 생성해 주세요.</Hint>}
        <Hint>알 수 없는 종목은 기본적으로 주식(STOCK)으로 만들어집니다. ETF·가상자산·사용자 자산은 같은 코드·거래소·통화로 먼저 등록하세요. 샘플은 가상 종목이며 실제 시장 데이터가 아닙니다.</Hint>
        <div className="form-actions"><Button asChild variant="outline"><a href="/sample-transactions.csv" download><Download />샘플 CSV 다운로드</a></Button><SubmitButton pending={mutation.pending} disabled={!data.accounts.length}><FileUp />업로드하고 계속</SubmitButton></div>
      </form>}
      {step === 1 && upload && <div className="form-stack">
        <div className="file-summary"><FileCheck2 size={24} /><div><strong>{upload.filename}</strong><span>{upload.rows.length}개 행 · 원본 파일 보존</span></div>{upload.duplicateFile && <span className="badge badge-warning">동일 파일 발견</span>}</div>
        {upload.duplicateFile && <Hint>이전에 업로드한 파일과 정확히 일치합니다. {upload.status === "CONFIRMED" ? "이미 반영된 파일은 다시 가져올 수 없습니다." : "이전 작업을 이어서 검증합니다. 중복 거래는 검증 단계에서 확인하세요."}</Hint>}
        <p className="text-muted text-sm">왼쪽 항목에 해당하는 파일 열을 선택하세요. 열 이름이 같은 항목만 자동으로 제안하며, 금액과 단가를 구분해야 합니다. 연결을 바꾸면 이후의 행 수정과 중복 선택은 초기화됩니다.</p>
        <div className="mapping-grid">{importFields.map((field) => <Field key={field} label={`${labels[field]} (${field})`} required={["date", "kind", "currency"].includes(field)}><Select aria-label={`${labels[field]} 열 연결`} value={mapping[field] ?? ""} onChange={(event) => { setMapping((previous) => ({ ...previous, [field]: event.target.value || undefined })); setChanges({}); setDecisions({}); setDirty(true); }}><option value="">연결하지 않음</option>{upload.headers.map((header) => <option key={header} value={header}>{header}</option>)}</Select></Field>)}</div>
        <details className="details"><summary>원본 데이터 미리보기 <ChevronDown size={15} /></summary><TableWrap><table><thead><tr>{upload.headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{upload.rows.slice(0, 5).map((row, index) => <tr key={index}>{upload.headers.map((header) => <td key={header}>{row[header] || "—"}</td>)}</tr>)}</tbody></table></TableWrap></details>
        <Hint>거래 유형: {Object.entries(kindLabels).map(([value, label]) => `${value}(${label})`).join(" · ")}. 배당금은 세전 금액, 수수료·세금은 별도 열로 입력하세요.</Hint>
        <div className="form-actions"><Button variant="outline" onClick={() => { setStep(0); setUpload(null); setValidation(null); setChanges({}); setDecisions({}); mutation.setError(null); }} disabled={mutation.pending}>다른 파일 선택</Button><Button onClick={validate} disabled={mutation.pending || !mapping.date || !mapping.kind || !mapping.currency || upload.status === "CONFIRMED"}>{mutation.pending ? "검증 중…" : "거래 검증하기"}<ArrowRight /></Button></div>
      </div>}
      {step === 2 && validation && <div className="form-stack">
        <div className="import-summary"><span>전체 <strong>{validation.summary.total}</strong></span><span>반영 <strong>{validation.summary.keep}</strong></span><span>제외 <strong>{validation.summary.skip}</strong></span><span className={validation.summary.errors ? "text-negative" : ""}>오류 <strong>{validation.summary.errors}</strong></span><span>검증 버전 {validation.revision}</span></div>
        <Hint>오류 행의 &lsquo;값 수정&rsquo;을 열어 표준 필드를 수정하세요. 유사 중복은 반드시 반영 또는 제외를 선택해야 합니다. 배당 일정 후보가 여러 개인 행은 &lsquo;제외&rsquo;한 뒤, 거래 추가에서 배당 일정을 직접 선택해 기록하세요. 변경한 내용은 다시 검증한 후 미리볼 수 있습니다.</Hint>
        <TableWrap><table className="import-table"><thead><tr><th>원본 행</th><th>거래일 / 유형</th><th>종목 / 금액</th><th>검증 상태</th><th>처리 결정</th><th>수정</th></tr></thead><tbody>{validation.rows.slice(page * 20, (page + 1) * 20).map((row) => <ImportRow key={row.rowNumber} row={row} changes={changes[row.rowNumber]} decision={decisions[row.rowNumber]} expanded={expanded === row.rowNumber} onToggle={() => setExpanded(expanded === row.rowNumber ? null : row.rowNumber)} onChange={(field, value) => {
          setChanges((previous) => ({ ...previous, [row.rowNumber]: { ...previous[row.rowNumber], [field]: value } }));
          setDecisions((previous) => { const next = { ...previous }; delete next[row.rowNumber]; return next; });
          setDirty(true);
        }} onDecision={(value) => { setDecisions((previous) => ({ ...previous, [row.rowNumber]: value })); setDirty(true); }} />)}</tbody></table></TableWrap>
        <div className="pagination"><span>{validation.rows.length}건 · {page + 1} / {Math.max(1, Math.ceil(validation.rows.length / 20))} 페이지</span><div><Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>이전 행</Button><Button variant="outline" size="sm" disabled={(page + 1) * 20 >= validation.rows.length} onClick={() => setPage(page + 1)}>다음 행</Button></div></div>
        {dirty && <p className="text-amber-700 text-sm" role="status">수정한 내용이 있습니다. &lsquo;다시 검증&rsquo;을 눌러 반영하세요.</p>}
        <div className="form-actions"><Button variant="ghost" onClick={() => setStep(1)} disabled={mutation.pending}><ArrowLeft />필드 연결 수정</Button><Button variant="outline" onClick={validate} disabled={mutation.pending}>{mutation.pending ? "검증 중…" : "다시 검증"}</Button><Button onClick={() => setStep(3)} disabled={!validation.valid || dirty || mutation.pending}>최종 미리보기<ArrowRight /></Button></div>
      </div>}
      {step === 3 && validation && <div className="form-stack">
        <div className="preview-heading"><CheckCircle2 size={30} /><h3>{validation.summary.keep}건의 거래를 반영할 준비가 됐어요</h3><p>{validation.summary.skip}건 제외 · 아직 원장에 반영되지 않았습니다.</p></div>
        <TableWrap><table><thead><tr><th>원본 행</th><th>날짜</th><th>유형</th><th>종목</th><th>통화</th><th className="numeric">수량</th><th className="numeric">단가</th><th className="numeric">금액</th></tr></thead><tbody>{validation.rows.filter((row) => row.decision === "KEEP").map((row) => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.values.date}</td><td>{kindLabels[row.values.kind as keyof typeof kindLabels] || row.values.kind}</td><td>{row.values.symbol || "—"}</td><td>{row.values.currency}</td><td className="numeric">{row.values.quantity || "—"}</td><td className="numeric">{row.values.price || "—"}</td><td className="numeric">{row.values.amount || "—"}</td></tr>)}</tbody></table></TableWrap>
        <Hint>확정하면 검증한 버전의 거래만 한 번에 저장됩니다. 최종 잔액·수량 검증에 실패하면 일부만 저장되지 않습니다. 실제 반영 후 거래 내역과 가격·환율 누락을 확인하세요.</Hint>
        <div className="form-actions"><Button variant="outline" onClick={() => setStep(2)} disabled={mutation.pending}>검증으로 돌아가기</Button><Button onClick={confirm} disabled={mutation.pending}>{mutation.pending ? "반영 중…" : `${validation.summary.keep}건 가져오기 확정`}<Check /></Button></div>
      </div>}
      {step === 4 && <div className="import-complete"><span><CheckCircle2 size={42} /></span><h3>기록이 안전하게 도착했어요</h3><p>{confirmedCount}건의 거래를 원장에 반영했습니다. 원본 파일과 행 데이터는 보존됩니다.</p><Button onClick={onClose}>거래 내역 확인하기</Button></div>}
      <ErrorNotice message={mutation.error} />
    </div>
  </Panel>;
}

function ImportRow({ row, changes, decision, expanded, onToggle, onChange, onDecision }: {
  row: ImportValidationResult["rows"][number]; changes?: Record<string, string>; decision?: "KEEP" | "SKIP";
  expanded: boolean; onToggle: () => void; onChange: (field: string, value: string) => void; onDecision: (value: "KEEP" | "SKIP") => void;
}) {
  return <><tr className={row.errors.length ? "row-error" : undefined}><td>{row.rowNumber}</td><td>{changes?.date ?? row.values.date}<small className="cell-sub">{changes?.kind ?? row.values.kind}</small></td><td>{changes?.symbol ?? row.values.symbol ?? "—"}<small className="cell-sub">{changes?.amount ?? row.values.amount ?? row.values.price} {changes?.currency ?? row.values.currency}</small></td><td>{row.errors.length ? <span className="badge badge-error">오류 {row.errors.length}개</span> : <span className="badge badge-success">형식 확인</span>}{row.duplicate !== "NONE" && <span className="badge badge-warning">{row.duplicate === "EXACT" ? "정확히 같은 거래" : "유사 중복 · 선택 필요"}</span>}</td><td><Select aria-label={`${row.rowNumber}행 중복 처리`} value={decision ?? row.decision} disabled={row.duplicate === "EXACT"} onChange={(event) => { if (event.target.value !== "UNDECIDED") onDecision(event.target.value as "KEEP" | "SKIP"); }}><option value="UNDECIDED" disabled>반영 여부 선택</option><option value="KEEP">반영</option><option value="SKIP">제외</option></Select></td><td><Button variant="outline" size="sm" onClick={onToggle} aria-expanded={expanded} aria-label={`${row.rowNumber}행 값 수정`}>값 수정<ChevronDown /></Button></td></tr>{expanded && <tr><td colSpan={6}><div className="row-correction">{row.errors.length > 0 && <ul className="field-errors" role="alert">{row.errors.map((error, index) => <li key={index}><strong>{Object.hasOwn(labels, error.field) ? labels[error.field as keyof typeof labels] : error.field}</strong>: {error.message}</li>)}</ul>}<div className="mapping-grid">{importFields.map((field) => <Field label={labels[field]} key={field}><Input aria-label={`${row.rowNumber}행 ${labels[field]}`} value={changes?.[field] ?? row.values[field] ?? ""} onChange={(event) => onChange(field, event.target.value)} aria-invalid={row.errors.some((error) => error.field === field)} /></Field>)}</div></div></td></tr>}</>;
}
