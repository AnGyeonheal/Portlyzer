"use client";

import { useEffect, useState } from "react";
import { FileClock, FileUp, Pencil, Plus, Search, Trash2 } from "lucide-react";
import type { TransactionDto } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, ErrorNotice, Loading } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/input";
import { errorMessage, request, useMutation } from "./api";
import { dateTime, kindLabels, money, quantity } from "./format";
import { ImportWizard } from "./import-wizard";
import { AssetName, Hint, Panel, TableWrap } from "./shared";
import { TransactionEditor } from "./transaction-editor";
import { useWorkspace } from "./workspace-context";

export function Transactions() {
  const { data, openTransaction } = useWorkspace();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [edit, setEdit] = useState<TransactionDto | null>(null);
  const [remove, setRemove] = useState<TransactionDto | null>(null);
  const [history, setHistory] = useState<TransactionDto | null>(null);
  const [importing, setImporting] = useState(false);
  const [page, setPage] = useState(0);
  const rows = [...data.transactions].filter((transaction) => {
    const asset = data.assets.find((item) => item.id === transaction.assetId);
    return (kind === "all" || transaction.kind === kind) && `${asset?.name || ""} ${asset?.symbol || ""} ${transaction.memo} ${transaction.tags.join(" ")}`.toLowerCase().includes(search.toLowerCase());
  }).sort((left, right) => right.date.localeCompare(left.date) || right.sequence - left.sequence);
  const pageSize = 20;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  return <div className="view-stack">
    <Panel className="import-invitation"><div className="import-invitation-content"><span className="feature-icon"><FileUp /></span><div><h2>엑셀 양식으로 거래를 한 번에</h2><p>빈 양식을 내려받아 작성한 뒤 올려 주세요. 검증·미리보기 후 확정한 거래만 반영합니다.</p></div></div><Button variant="outline" onClick={() => setImporting(true)}><FileUp />파일 가져오기</Button></Panel>
    {importing && <ImportWizard onClose={() => setImporting(false)} />}
    <Panel title="모든 거래" description={`선택한 기간·계좌의 거래 ${rows.length.toLocaleString("ko-KR")}건`} action={<Button size="sm" onClick={openTransaction}><Plus />거래 추가</Button>}>
      <div className="table-toolbar"><div className="search-field"><Search size={17} /><Input aria-label="거래 검색" placeholder="종목, 메모, 태그 검색" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} /></div><Select aria-label="거래 유형 필터" value={kind} onChange={(event) => { setKind(event.target.value); setPage(0); }}><option value="all">모든 거래 유형</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></div>
      {!rows.length ? <EmptyState title="표시할 거래가 없어요" description="조건을 바꾸거나 첫 거래를 기록해 보세요. 먼저 계좌와 종목을 설정할 수 있습니다." action={<Button onClick={openTransaction}>첫 거래 기록하기</Button>} /> : <><TableWrap><table><thead><tr><th>거래일</th><th>종목 / 유형</th><th>계좌</th><th className="numeric">수량</th><th className="numeric">단가 / 금액</th><th className="numeric">수수료 · 세금</th><th>메모 / 출처</th><th>관리</th></tr></thead><tbody>{rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((transaction) => {
        const asset = data.assets.find((item) => item.id === transaction.assetId);
        return <tr key={transaction.id}><td className="nowrap">{transaction.date}<small className="cell-sub">#{transaction.sequence}</small></td><td>{asset ? <AssetName asset={asset} /> : <strong>{kindLabels[transaction.kind]}</strong>}<span className={`badge transaction-${transaction.kind}`}>{kindLabels[transaction.kind]}</span></td><td>{data.accounts.find((account) => account.id === transaction.accountId)?.name ?? "—"}{transaction.toAccountId && <small className="cell-sub">→ {data.accounts.find((account) => account.id === transaction.toAccountId)?.name ?? "—"}</small>}</td><td className="numeric">{quantity(transaction.quantity)}{transaction.kind === "SPLIT" && <small className="cell-sub">비율 {quantity(transaction.ratio)}</small>}</td><td className="numeric">{money(transaction.amount ?? transaction.price, transaction.currency)}<small className="cell-sub">{transaction.currency}{transaction.kind === "FX" && ` → ${money(transaction.toAmount, transaction.toCurrency ?? "USD")}`}</small></td><td className="numeric">{money(transaction.fee, transaction.currency)}<small className="cell-sub">세금 {money(transaction.tax, transaction.currency)}</small></td><td className="memo-cell">{transaction.memo || "—"}<div className="tag-row">{transaction.tags.map((tag) => <span className="tag" key={tag}>#{tag}</span>)}</div><small className="cell-sub">{transaction.source === "MANUAL" ? "직접 입력" : transaction.source === "IMPORT" ? "파일 가져오기" : transaction.source} · v{transaction.revision}</small></td><td><div className="row-actions"><Button variant="ghost" size="icon" aria-label={`${transaction.date} ${kindLabels[transaction.kind]} 거래 수정`} onClick={() => setEdit(transaction)}><Pencil /></Button><Button variant="ghost" size="icon" aria-label={`${transaction.date} 거래 변경 이력`} onClick={() => setHistory(transaction)}><FileClock /></Button><Button variant="ghost" size="icon" aria-label={`${transaction.date} 거래 삭제`} onClick={() => setRemove(transaction)}><Trash2 /></Button></div></td></tr>;
      })}</tbody></table></TableWrap><div className="pagination"><span>{rows.length}건 중 {currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, rows.length)}</span><div><Button variant="outline" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>이전</Button><Button variant="outline" size="sm" disabled={(currentPage + 1) * pageSize >= rows.length} onClick={() => setPage(currentPage + 1)}>다음</Button></div></div></>}
    </Panel>
    <Hint>가져온 거래도 수정할 수 있으며 원본과 변경 이력은 보존됩니다. 같은 날의 거래는 순서에 따라 계산됩니다. 원본 포함 전체 데이터는 설정에서 내보낼 수 있습니다.</Hint>
    {edit && <TransactionEditor transaction={edit} onClose={() => setEdit(null)} />}
    {remove && <DeleteTransaction transaction={remove} onClose={() => setRemove(null)} />}
    {history && <TransactionHistory transaction={history} onClose={() => setHistory(null)} />}
  </div>;
}

function DeleteTransaction({ transaction, onClose }: { transaction: TransactionDto; onClose: () => void }) {
  const { refresh, notify } = useWorkspace();
  const mutation = useMutation();
  return <Dialog title="거래를 삭제할까요?" description={`${transaction.date} · ${kindLabels[transaction.kind]}`} onClose={onClose}><div className="form-stack"><p>삭제하면 보유 수량, 현금 잔액과 수익률이 다시 계산됩니다. 원본과 삭제 이력은 감사 기록에 남습니다.</p><ErrorNotice message={mutation.error} /><div className="form-actions"><Button variant="outline" onClick={onClose} disabled={mutation.pending}>취소</Button><Button variant="destructive" disabled={mutation.pending} onClick={() => mutation.run(() => request(`/api/transactions/${transaction.id}`, { method: "DELETE", body: JSON.stringify({ revision: transaction.revision }) }), () => { notify("거래를 삭제했습니다."); refresh(); onClose(); })}>{mutation.pending ? "삭제 중…" : "거래 삭제 확인"}</Button></div></div></Dialog>;
}

interface HistoryResult {
  transaction: TransactionDto & { deletedAt: string | null };
  original: { source: string; createdAt: string; rowNumber: number | null; sourceTransactionId: string | null; rawData: unknown };
  revisions: { id: string; version: number; operation: string; before: unknown; after: unknown; createdAt: string }[];
}

function TransactionHistory({ transaction, onClose }: { transaction: TransactionDto; onClose: () => void }) {
  const [result, setResult] = useState<HistoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    request<HistoryResult>(`/api/transactions/${transaction.id}/history`, { signal: controller.signal }).then(setResult).catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [transaction.id, retry]);
  return <Dialog title="거래 변경 이력" description={`${transaction.date} · ${kindLabels[transaction.kind]} · 현재 버전 ${transaction.revision}`} onClose={onClose} wide><div className="form-stack"><Hint>최초 원본과 이후 수정·삭제 기록입니다. 파일로 가져온 거래의 원본 열과 값도 그대로 보존됩니다.</Hint><ErrorNotice message={error} />{error ? <Button variant="outline" onClick={() => { setError(null); setRetry(retry + 1); }}>이력 다시 불러오기</Button> : result === null ? <Loading /> : <>
    <section className="audit-entry"><div className="audit-heading"><span className="badge badge-info">최초 원본</span><span>{dateTime(result.original.createdAt)}</span></div><p>{result.original.source === "MANUAL" ? "직접 입력" : "파일 가져오기"}{result.original.rowNumber !== null && ` · 원본 ${result.original.rowNumber}행`}{result.original.sourceTransactionId && ` · 원본 거래 ID ${result.original.sourceTransactionId}`}</p><details open><summary>보존된 원본 값</summary><AuditSnapshot value={result.original.rawData} /></details></section>
    <h3 className="section-title">변경 기록 {result.revisions.length}건</h3>
    {!result.revisions.length && <p className="text-muted text-sm">원본 이후의 변경 기록이 없습니다.</p>}
    {result.revisions.map((revision) => <section className="audit-entry" key={revision.id}><div className="audit-heading"><strong>버전 {revision.version}</strong><span className="badge">{({ CREATE: "생성", UPDATE: "수정", DELETE: "삭제", RESTORE: "복원" } as Record<string, string>)[revision.operation] || revision.operation}</span><span>{dateTime(revision.createdAt)}</span></div><div className="audit-comparison"><details><summary>변경 전</summary><AuditSnapshot value={revision.before} /></details><details><summary>변경 후</summary><AuditSnapshot value={revision.after} /></details></div></section>)}
    <details className="details"><summary>전체 감사 기록 JSON 보기</summary><pre className="audit-json" aria-label="거래 원본과 변경 이력 JSON">{JSON.stringify(result, null, 2)}</pre></details>
  </>}</div></Dialog>;
}

const auditLabels: Record<string, string> = { date: "거래일", kind: "거래 유형", accountId: "계좌 ID", assetId: "종목 ID", currency: "통화", quantity: "수량", price: "단가", amount: "금액", fee: "수수료", tax: "세금", memo: "메모", tags: "태그", revision: "버전", toAccountId: "받는 계좌", toCurrency: "환전 도착 통화", toAmount: "환전 입금액", ratio: "분할 비율", dividendEventId: "연결 배당 일정", sequence: "거래 순서", deletedAt: "삭제 시각", symbol: "종목 코드", exchange: "거래소" };

function AuditSnapshot({ value }: { value: unknown }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return <p className="audit-empty">기록 없음</p>;
  return <dl className="audit-values">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{auditLabels[key] || key}</dt><dd>{key === "kind" && typeof item === "string" ? kindLabels[item as keyof typeof kindLabels] || item : item === null || item === "" ? "—" : Array.isArray(item) ? item.join(", ") || "—" : typeof item === "object" ? JSON.stringify(item) : String(item)}</dd></div>)}</dl>;
}
