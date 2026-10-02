"use client";

import type { DividendUpcoming } from "@/lib/contracts";
import type { Currency } from "@/lib/domain";
import { Field, Select } from "@/components/ui/input";

export type DividendLinkEvent = Pick<DividendUpcoming, "id" | "assetId" | "currency" | "status" | "payDate" | "amountPerShare">;

export function readDividendCandidates(details: unknown): DividendLinkEvent[] {
  if (!details || typeof details !== "object" || !("candidates" in details) || !Array.isArray(details.candidates)) return [];
  return details.candidates.flatMap((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id || typeof row.assetId !== "string" ||
      (row.currency !== "KRW" && row.currency !== "USD") ||
      (row.status !== "ANNOUNCED" && row.status !== "ESTIMATED") ||
      (row.payDate !== null && typeof row.payDate !== "string") || typeof row.amountPerShare !== "string") return [];
    return [{
      id: row.id, assetId: row.assetId, currency: row.currency, status: row.status,
      payDate: typeof row.payDate === "string" ? row.payDate.slice(0, 10) : null, amountPerShare: row.amountPerShare,
    }];
  });
}

export function DividendEventField({ assetId, currency, symbol, events, candidates, value, onChange, disabled }: {
  assetId: string; currency: Currency; symbol: string; events: readonly DividendLinkEvent[];
  candidates: readonly DividendLinkEvent[]; value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  const applicable = (event: DividendLinkEvent) => event.assetId === assetId && event.currency === currency;
  const matchingCandidates = candidates.filter(applicable);
  const options = [...new Map([...events.filter(applicable), ...matchingCandidates].map((event) => [event.id, event])).values()];
  const requiresChoice = matchingCandidates.length > 1;
  const currentOutsideList = !!value && !options.some((event) => event.id === value);
  return <Field label="연결할 배당 일정" className="full-width" required={requiresChoice}
    hint={requiresChoice
      ? `자동 연결 후보가 ${matchingCandidates.length}개입니다. 지급일·상태·주당 배당금을 확인하고 하나를 직접 선택해 주세요.`
      : "자동 연결은 같은 종목·통화의 지급일이 입금일 ±7일 이내인 일정이 하나일 때만 적용됩니다. 후보가 없으면 미연결로 기록되며, 직접 선택한 일정에는 날짜 제한을 적용하지 않습니다."}>
    <Select name="dividendEventId" value={value} onChange={(event) => onChange(event.target.value)}
      disabled={disabled || !assetId} required={requiresChoice} aria-invalid={requiresChoice && !value}>
      <option value="">자동 연결 · 유일한 지급일 ±7일 일정</option>
      {currentOutsideList && <option value={value}>현재 연결된 일정 · 조회 범위 밖 (연결 유지)</option>}
      {options.map((event) => <option key={event.id} value={event.id}>
        {symbol} · 지급일 {event.payDate || "미정"} · {event.status === "ANNOUNCED" ? "공시" : "추정"} · 주당 {event.amountPerShare} {event.currency}
      </option>)}
    </Select>
  </Field>;
}
