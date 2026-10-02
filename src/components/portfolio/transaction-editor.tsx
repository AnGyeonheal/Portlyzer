"use client";

import { useState, type FormEvent } from "react";
import type { TransactionDto } from "@/lib/contracts";
import type { Currency, TransactionKind } from "@/lib/domain";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorNotice, SubmitButton } from "@/components/ui/feedback";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ApiError, request, useMutation } from "./api";
import { DividendEventField, readDividendCandidates, type DividendLinkEvent } from "./dividend-event-field";
import { kindLabels, today } from "./format";
import { Hint } from "./shared";
import { useWorkspace } from "./workspace-context";

export function TransactionEditor({ transaction, onClose, defaultAssetId, defaultKind = "BUY" }: {
  transaction?: TransactionDto; onClose: () => void; defaultAssetId?: string; defaultKind?: TransactionKind;
}) {
  const { data, filters, refresh, notify } = useWorkspace();
  const [kind, setKind] = useState<TransactionKind>(transaction?.kind ?? defaultKind);
  const [accountId, setAccountId] = useState(transaction?.accountId ?? (filters.accountId === "all" ? data.accounts[0]?.id ?? "" : filters.accountId));
  const [assetId, setAssetId] = useState(transaction?.assetId ?? defaultAssetId ?? "");
  const [currency, setCurrency] = useState<Currency>(transaction?.currency ?? data.assets.find((asset) => asset.id === defaultAssetId)?.currency ?? data.accounts.find((account) => account.id === accountId)?.currency ?? "KRW");
  const [transferMode, setTransferMode] = useState(transaction?.assetId ? "asset" : "cash");
  const [dividendEventId, setDividendEventId] = useState(transaction?.dividendEventId ?? "");
  const [dividendCandidates, setDividendCandidates] = useState<DividendLinkEvent[]>([]);
  const mutation = useMutation();
  const assetRequired = ["BUY", "SELL", "DIVIDEND", "SPLIT", "VALUATION"].includes(kind) || (kind === "TRANSFER" && transferMode === "asset");
  const hasQuantity = ["BUY", "SELL"].includes(kind) || (kind === "TRANSFER" && transferMode === "asset");
  const hasPrice = ["BUY", "SELL", "VALUATION"].includes(kind);
  const hasAmount = ["DEPOSIT", "WITHDRAWAL", "DIVIDEND", "INTEREST", "FEE", "TAX", "FX"].includes(kind) || (kind === "TRANSFER" && transferMode === "cash");
  const hasCosts = !["SPLIT", "VALUATION", "FEE", "TAX"].includes(kind);
  const availableAssets = kind === "VALUATION" ? data.assets.filter((asset) => asset.assetClass === "CUSTOM") : data.assets;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const text = (name: string) => String(values.get(name) ?? "").trim();
    const payload = {
      accountId, date: text("date"), kind, currency,
      assetId: assetRequired || kind === "DIVIDEND" ? assetId || null : null,
      quantity: hasQuantity ? text("quantity") : null,
      price: hasPrice ? text("price") : null,
      amount: hasAmount ? text("amount") : null,
      fee: hasCosts ? text("fee") || "0" : "0",
      tax: hasCosts ? text("tax") || "0" : "0",
      toAccountId: kind === "TRANSFER" ? text("toAccountId") : null,
      toCurrency: kind === "FX" ? text("toCurrency") : null,
      toAmount: kind === "FX" ? text("toAmount") : null,
      ratio: kind === "SPLIT" ? text("ratio") : null,
      dividendEventId: kind === "DIVIDEND" ? dividendEventId || null : null,
      memo: text("memo"), tags: [...new Set(text("tags").split(",").map((tag) => tag.trim()).filter(Boolean))],
      ...(transaction ? { revision: transaction.revision } : {}),
    };
    await mutation.run(
      async () => {
        try {
          return await request<TransactionDto>(`/api/transactions${transaction ? `/${transaction.id}` : ""}`, { method: transaction ? "PATCH" : "POST", body: JSON.stringify(payload) });
        } catch (cause) {
          if (cause instanceof ApiError && cause.code === "DIVIDEND_MATCH_AMBIGUOUS") setDividendCandidates(readDividendCandidates(cause.details));
          throw cause;
        }
      },
      (saved) => {
        notify(kind === "DIVIDEND" && !dividendEventId && saved.dividendEventId
          ? "거래를 저장하고 유일한 배당 일정에 자동 연결했습니다."
          : transaction ? "거래를 수정하고 변경 이력을 남겼습니다." : "거래가 기록되었습니다.");
        refresh(); onClose();
      },
    );
  }

  return (
    <Dialog title={transaction ? "거래 수정" : "거래 추가"} description={transaction ? `수정 버전 ${transaction.revision} · 원본은 변경 이력에 보존됩니다.` : "실제 체결·수령 내역을 입력하세요. 통화별 원장을 기준으로 계산합니다."} onClose={onClose} wide>
      <form onSubmit={submit} className="form-stack">
        {!data.accounts.length && <Hint>먼저 설정 → 계좌 관리에서 계좌를 추가해 주세요.</Hint>}
        <fieldset className="form-grid m-0 border-0 p-0" disabled={mutation.pending}>
          <Field label="거래 유형" required><Select value={kind} onChange={(event) => setKind(event.target.value as TransactionKind)}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
          <Field label="거래일" required><Input name="date" type="date" defaultValue={transaction?.date ?? today()} max={today()} onChange={() => { setDividendCandidates([]); mutation.setError(null); }} required /></Field>
          <Field label="거래 계좌" required><Select value={accountId} onChange={(event) => { setAccountId(event.target.value); if (!assetId) setCurrency(data.accounts.find((account) => account.id === event.target.value)?.currency ?? "KRW"); }} required><option value="">계좌 선택</option>{data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</Select></Field>
          <Field label="거래 통화" required><Select value={currency} onChange={(event) => { setCurrency(event.target.value as Currency); setDividendEventId(""); setDividendCandidates([]); }}><option value="KRW">KRW · 원화</option><option value="USD">USD · 미국 달러</option></Select></Field>
          {kind === "TRANSFER" && <Field label="이체 대상" required><Select value={transferMode} onChange={(event) => setTransferMode(event.target.value)}><option value="cash">현금</option><option value="asset">보유 증권</option></Select></Field>}
          {(assetRequired || kind === "DIVIDEND") && <Field label="종목" required={assetRequired} hint={kind === "VALUATION" ? "사용자 자산(CUSTOM)만 평가할 수 있습니다. 현금 흐름은 발생하지 않습니다." : "종목이 없다면 설정 → 종목 관리에서 먼저 등록하세요."}><Select value={assetId} onChange={(event) => { setAssetId(event.target.value); setDividendEventId(""); setDividendCandidates([]); const asset = data.assets.find((item) => item.id === event.target.value); if (asset) setCurrency(asset.currency); }} required={assetRequired}><option value="">{assetRequired ? "종목 선택" : "미지정"}</option>{availableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} ({asset.symbol} · {asset.currency})</option>)}</Select></Field>}
          {hasQuantity && <Field label="수량" required><Input name="quantity" type="number" step="any" min="0.00000001" defaultValue={transaction?.quantity ?? ""} placeholder="0" required /></Field>}
          {hasPrice && <Field label={kind === "VALUATION" ? "단위당 평가 가격" : "체결 단가"} required><Input name="price" type="number" step="any" min="0.000000000001" defaultValue={transaction?.price ?? ""} placeholder="0" required /></Field>}
          {hasAmount && <Field label={kind === "DIVIDEND" ? "세전 배당금" : kind === "FX" ? "환전 출금액" : "거래 금액"} required><Input name="amount" type="number" step="any" min="0.00000001" defaultValue={transaction?.amount ?? ""} placeholder="0" required /></Field>}
          {kind === "TRANSFER" && <Field label="받는 계좌" required><Select name="toAccountId" defaultValue={transaction?.toAccountId ?? ""} required><option value="">계좌 선택</option>{data.accounts.filter((account) => account.id !== accountId).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</Select></Field>}
          {kind === "FX" && <><Field label="환전 도착 통화" required><Select name="toCurrency" key={currency} defaultValue={transaction?.toCurrency !== currency ? transaction?.toCurrency ?? (currency === "KRW" ? "USD" : "KRW") : currency === "KRW" ? "USD" : "KRW"}><option value={currency === "KRW" ? "USD" : "KRW"}>{currency === "KRW" ? "USD · 미국 달러" : "KRW · 원화"}</option></Select></Field><Field label="환전 입금액" required><Input name="toAmount" type="number" step="any" min="0.00000001" defaultValue={transaction?.toAmount ?? ""} required /></Field></>}
          {kind === "SPLIT" && <Field label="분할 비율" required hint="신주 / 구주 비율. 1주가 4주가 되면 4, 10주가 1주가 되면 0.1"><Input name="ratio" type="number" step="any" min="0.00000001" defaultValue={transaction?.ratio ?? ""} required /></Field>}
          {hasCosts && <><Field label="수수료"><Input name="fee" type="number" step="any" min="0" defaultValue={transaction?.fee ?? "0"} /></Field><Field label="세금"><Input name="tax" type="number" step="any" min="0" defaultValue={transaction?.tax ?? "0"} /></Field></>}
          {kind === "DIVIDEND" && <DividendEventField assetId={assetId} currency={currency}
            symbol={data.assets.find((asset) => asset.id === assetId)?.symbol ?? ""}
            events={data.dividends.upcoming} candidates={dividendCandidates} value={dividendEventId}
            onChange={(value) => { setDividendEventId(value); mutation.setError(null); }} />}
          <Field label="메모" className="full-width"><Textarea name="memo" defaultValue={transaction?.memo ?? ""} placeholder="이 거래를 기록해 둘 나만의 이유" maxLength={1000} /></Field>
          <Field label="태그" className="full-width" hint="쉼표로 구분해 입력하세요. 예: 장기, 배당, 리밸런싱"><Input name="tags" defaultValue={transaction?.tags.join(", ") ?? ""} placeholder="장기, 배당" /></Field>
        </fieldset>
        {kind === "TRANSFER" && <Hint>내 계좌 간 이체는 전체 포트폴리오의 외부 입출금이 아닙니다. 계좌 필터에서는 경계 현금흐름으로 처리됩니다.</Hint>}
        <ErrorNotice message={mutation.error} />
        <div className="form-actions"><Button variant="outline" onClick={onClose} disabled={mutation.pending}>취소</Button><SubmitButton pending={mutation.pending} disabled={!data.accounts.length}>{transaction ? "수정 저장" : "거래 기록하기"}</SubmitButton></div>
      </form>
    </Dialog>
  );
}
