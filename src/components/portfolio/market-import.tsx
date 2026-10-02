"use client";

import { useState, type FormEvent } from "react";
import { CheckCircle2, Download, FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorNotice, Loading } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/input";
import { ApiError, errorMessage, request, useMutation } from "./api";
import { parseMarketCsv, type MarketCsvKind, type MarketCsvPreview } from "./market-csv";
import { Hint, TableWrap } from "./shared";
import { useWorkspace } from "./workspace-context";

export function MarketCsvImport({ kind, onClose }: { kind: MarketCsvKind; onClose: () => void }) {
  const { data, filters, refresh, notify } = useWorkspace();
  const label = kind === "PRICE" ? "가격" : "환율";
  const [preview, setPreview] = useState<MarketCsvPreview | null>(null);
  const [filename, setFilename] = useState("");
  const [reading, setReading] = useState(false);
  const [page, setPage] = useState(0);
  const [completed, setCompleted] = useState<number | null>(null);
  const [serverDetails, setServerDetails] = useState<unknown>(null);
  const mutation = useMutation();
  const pending = reading || mutation.pending;

  function template() {
    const asset = data.assets[0];
    const fields = kind === "PRICE" ? ["date", "symbol", "exchange", "close", "currency"] : ["date", "base", "quote", "rate"];
    const values = kind === "PRICE"
      ? [filters.to, asset?.symbol ?? "005930", asset?.exchange ?? "KRX", "", asset?.currency ?? "KRW"]
      : [filters.to, "USD", "KRW", ""];
    const csv = "\uFEFF" + fields.join(",") + "\r\n" + values.map((value) => `"${value.replaceAll('"', '""')}"`).join(",") + "\r\n";
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = kind === "PRICE" ? "price-history-template.csv" : "fx-history-template.csv";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get("file");
    mutation.setError(null);
    setPreview(null);
    setServerDetails(null);
    if (!(file instanceof File) || !file.size) { mutation.setError("CSV 파일을 선택해 주세요."); return; }
    if (!/\.csv$/i.test(file.name)) { mutation.setError("UTF-8 CSV 파일만 지원합니다."); return; }
    if (file.size > 2 * 1024 * 1024) { mutation.setError("파일 크기는 2 MiB 이하여야 합니다."); return; }
    setReading(true);
    try {
      const bytes = await file.arrayBuffer();
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new Error("UTF-8로 읽을 수 없는 파일입니다. CSV UTF-8 형식으로 다시 저장해 주세요."); }
      const result = parseMarketCsv(text, kind, data.assets);
      setPreview(result);
      setFilename(file.name);
      const firstError = result.rows.findIndex((row) => row.errors.length);
      setPage(firstError < 0 ? 0 : Math.floor(firstError / 20));
    } catch (cause) {
      mutation.setError(errorMessage(cause));
    } finally {
      setReading(false);
    }
  }

  async function confirm() {
    if (!preview || preview.invalid || !preview.payload.length || pending) return;
    setServerDetails(null);
    await mutation.run(async () => {
      try {
        return await request<{ count: number; source: string }>(kind === "PRICE" ? "/api/prices/import" : "/api/fx/import", {
          method: "POST", body: JSON.stringify({ rows: preview.payload }),
        });
      } catch (cause) {
        if (cause instanceof ApiError) setServerDetails(cause.details ?? null);
        throw cause;
      }
    }, (result) => {
      setCompleted(result.count);
      notify(`${result.count}개의 ${label} 관측치를 저장했습니다.`);
      refresh();
    });
  }

  return <Dialog title={`${label} CSV 가져오기`} description="UTF-8 CSV · 최대 2 MiB, 데이터 2,000행 · 검토 후 전체를 한 번에 저장" onClose={onClose} wide>
    {completed !== null ? <div className="import-complete"><span><CheckCircle2 size={40} /></span><h3>{label} CSV 등록 완료</h3><p>{completed}개 관측치를 MANUAL 출처로 저장했습니다. 보유 자산과 수익률이 다시 계산됩니다.</p><Button onClick={onClose}>등록 내역 확인하기</Button></div> : <div className="form-stack">
      <Hint>{kind === "PRICE" ? "종목 코드(symbol), 거래소(exchange), 통화(currency)로 등록된 종목을 찾습니다. ID를 입력할 필요가 없습니다. 국내 주식·ETF·가상자산·사용자 자산의 과거 원시 종가(RAW)를 올릴 수 있으며 조정종가는 지원하지 않습니다." : "date, base, quote, rate 열을 사용하세요. 환율은 1 기준 통화(base) = rate 상대 통화(quote)입니다. KRW·USD의 과거 참조 환율을 등록할 수 있습니다."}</Hint>
      <form className="form-stack" onSubmit={prepare}>
        <Field label={`${label} CSV 파일`} required hint={kind === "PRICE" ? "필수 열: date, symbol, exchange, close, currency · 종목 코드 앞자리 0을 보존하세요." : "필수 열: date, base, quote, rate"}>
          <Input name="file" type="file" accept=".csv,text/csv" required disabled={pending} onChange={() => { setPreview(null); mutation.setError(null); setServerDetails(null); }} />
        </Field>
        <div className="button-row"><Button variant="outline" onClick={template} disabled={pending}><Download />CSV 양식 다운로드</Button><Button type="submit" disabled={pending}><FileUp />{reading ? "CSV 읽는 중…" : "CSV 미리보기"}</Button></div>
        <p className="field-hint">양식의 종가·환율은 비워 두었습니다. 실제 관측값으로 채워 주세요. 쉼표가 포함된 값은 CSV 따옴표 규칙으로 처리하며 날짜는 연·월·일 순서로 입력합니다.</p>
      </form>
      {reading && <Loading label="CSV를 읽고 모든 행을 검증하고 있어요…" />}
      {preview && <>
        <div className="file-summary"><FileUp size={22} /><div><strong>{filename}</strong><span>아직 저장되지 않았습니다.</span></div></div>
        <div className="import-summary"><span>전체 <strong>{preview.rows.length}</strong>행</span><span>정상 <strong>{preview.rows.length - preview.invalid}</strong>행</span><span className={preview.invalid ? "text-negative" : ""}>오류 <strong>{preview.invalid}</strong>행</span></div>
        {preview.invalid > 0 && <ErrorNotice message="오류가 있는 행은 아래 표에서 확인하세요. 파일을 수정하고 다시 선택해 주세요. 모든 행이 정상이어야 저장할 수 있습니다." />}
        <TableWrap><table><thead><tr><th>CSV 행</th><th>기준일</th>{kind === "PRICE" ? <><th>종목 / 거래소</th><th>통화</th><th className="numeric">원시 종가</th></> : <><th>기준 통화</th><th>상대 통화</th><th className="numeric">환율</th></>}<th>검증 결과</th></tr></thead><tbody>{preview.rows.slice(page * 20, (page + 1) * 20).map((row) => <tr key={row.rowNumber} className={row.errors.length ? "row-error" : undefined}><td>{row.rowNumber}</td><td className="nowrap">{row.values.date || "—"}</td>{kind === "PRICE" ? <><td><strong>{row.assetName || row.values.symbol || "미지정"}</strong><small className="cell-sub">{row.values.symbol} · {row.values.exchange}</small></td><td>{row.values.currency || "—"}</td><td className="numeric">{row.values.close || "—"}</td></> : <><td>{row.values.base || "—"}</td><td>{row.values.quote || "—"}</td><td className="numeric">{row.values.rate || "—"}</td></>}<td>{row.errors.length ? <ul className="field-errors">{row.errors.map((error) => <li key={error}>{error}</li>)}</ul> : <span className="badge badge-success">확인 완료</span>}</td></tr>)}</tbody></table></TableWrap>
        <div className="pagination"><span>{page + 1} / {Math.ceil(preview.rows.length / 20)} 페이지</span><div><Button variant="outline" size="sm" disabled={!page || pending} onClick={() => setPage(page - 1)}>이전 행</Button><Button variant="outline" size="sm" disabled={(page + 1) * 20 >= preview.rows.length || pending} onClick={() => setPage(page + 1)}>다음 행</Button></div></div>
      </>}
      <Hint>수동 입력(MANUAL)은 같은 기준일의 외부 수집값보다 우선합니다. 동일한 종목·날짜 또는 통화쌍·날짜의 기존 수동 관측치는 갱신되며, 외부 공급자 관측치는 보존됩니다. {kind === "FX" && "역방향 통화쌍도 동일하게 취급하므로 기존 수동 입력의 반대 방향은 대체됩니다. "}한 행이라도 최종 검증에 실패하면 전체가 저장되지 않습니다.</Hint>
      <ErrorNotice message={mutation.error} />
      {serverDetails !== null && <details className="details"><summary>서버 검증 상세</summary><pre className="audit-json">{JSON.stringify(serverDetails, null, 2)}</pre></details>}
      <div className="form-actions"><Button variant="outline" onClick={onClose} disabled={pending}>취소</Button><Button disabled={!preview || !!preview.invalid || !preview.payload.length || pending} onClick={confirm}>{mutation.pending ? "전체 저장 중…" : `${preview?.rows.length ?? 0}개 ${label} 등록 확정`}</Button></div>
    </div>}
  </Dialog>;
}
