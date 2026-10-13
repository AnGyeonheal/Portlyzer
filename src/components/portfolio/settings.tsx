"use client";

import { useState, type FormEvent, type MouseEvent } from "react";
import { Download, LockKeyhole, Save, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorNotice, SubmitButton } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/input";
import { AccountManagement, AssetManagement } from "./settings-managers";
import { MarketSettings } from "./settings-market";
import { request, useMutation } from "./api";
import { Hint, Panel } from "./shared";
import { useWorkspace } from "./workspace-context";
import type { Currency } from "@/lib/domain";
import { SecuritySettings } from "./settings-security";

const tabs = [{ id: "general", label: "일반" }, { id: "accounts", label: "계좌·포트폴리오" }, { id: "assets", label: "종목 관리" }, { id: "market", label: "가격·환율" }, { id: "security", label: "계정·보안" }];

export function Settings({ initialTab }: { initialTab?: "market" } = {}) {
  const { data } = useWorkspace();
  const [tab, setTab] = useState(initialTab ?? (data.accounts.length ? "general" : "accounts"));
  return <div className="view-stack"><div className="settings-tabs" role="group" aria-label="설정 분류">{tabs.map((item) => <button key={item.id} aria-pressed={tab === item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>{tab === "general" && <GeneralSettings />}{tab === "accounts" && <AccountManagement />}{tab === "assets" && <AssetManagement />}{tab === "market" && <MarketSettings />}{tab === "security" && <SecuritySettings />}</div>;
}

function GeneralSettings() {
  const { data, filters, setFilters, refresh, notify } = useWorkspace();
  const mutation = useMutation();
  const exportMutation = useMutation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const currency = String(values.get("baseCurrency")) as Currency;
    const payload = { name: String(values.get("name")).trim(), baseCurrency: currency, costMethod: String(values.get("costMethod")), benchmarkAssetId: String(values.get("benchmarkAssetId") || "") || null };
    await mutation.run(() => request("/api/settings", { method: "PATCH", body: JSON.stringify(payload) }), () => { notify("분석 설정을 저장했습니다."); setFilters({ ...filters, currency }); refresh(); });
  }
  async function exportData(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (exportMutation.pending) return;
    await exportMutation.run(() => request<unknown>("/api/export"), (result) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `portlyzer-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      notify("전체 데이터 내보내기를 완료했습니다.");
    });
  }
  return <div className="view-stack"><Panel title="나의 기본 설정" description="원장 기록은 그대로 두고, 분석과 표시의 기준을 정합니다." action={<Settings2 size={19} className="text-muted" />}><form className="settings-form form-stack" onSubmit={submit} key={`${data.user.costMethod}-${data.user.baseCurrency}-${data.user.benchmarkAssetId}-${data.user.name}`}><div className="form-grid">
    <Field label="이름" required><Input name="name" defaultValue={data.user.name} maxLength={80} required /></Field>
    <Field label="이메일"><Input value={data.user.email} disabled readOnly /></Field>
    <Field label="기본 표시 통화" required><Select name="baseCurrency" defaultValue={data.user.baseCurrency}><option value="KRW">KRW · 대한민국 원</option><option value="USD">USD · 미국 달러</option></Select></Field>
    <Field label="매입 원가 계산 방식" required><Select name="costMethod" defaultValue={data.user.costMethod}><option value="FIFO">FIFO · 선입선출</option><option value="AVERAGE">AVERAGE · 이동평균</option></Select></Field>
    <Field label="가격 벤치마크" className="full-width" hint="배당 재투자 총수익 지수가 아닌 원시 종가 기반 비교입니다."><Select name="benchmarkAssetId" defaultValue={data.user.benchmarkAssetId ?? ""}><option value="">벤치마크 사용 안 함</option>{data.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name} ({asset.symbol} · {asset.currency})</option>)}</Select></Field>
  </div><Hint>원가 계산 방식을 바꾸면 모든 관련 분석이 다시 계산됩니다. 원본 거래나 세무 신고 자료가 수정되는 것은 아니며, 세무 목적으로는 증권사 자료를 확인하세요.</Hint><ErrorNotice message={mutation.error} /><div className="form-actions"><SubmitButton pending={mutation.pending}><Save />설정 저장하기</SubmitButton></div></form></Panel>
    <Panel title="내 데이터는 내가 관리해요" description="원본 가져오기 데이터와 감사 이력을 포함한 전체 JSON 백업입니다."><div className="export-settings"><span className="feature-icon"><Download /></span><div><h3>전체 기록 내보내기</h3><p>계좌·종목·거래·가격·환율·목표를 보존합니다. 비밀번호와 세션 인증 정보는 포함하지 않습니다.</p></div><Button asChild variant="outline" disabled={exportMutation.pending}><a href="/api/export" download="portlyzer-export.json" onClick={exportData} aria-disabled={exportMutation.pending}><Download />{exportMutation.pending ? "내보내는 중…" : "내 데이터 내보내기"}</a></Button></div><div className="px-panel"><ErrorNotice message={exportMutation.error} /></div></Panel>
    <Hint><span className="inline-flex items-center gap-2"><LockKeyhole size={16} />비밀번호나 공급자 API 키를 프런트엔드에 저장하지 않습니다. 데이터 제공 키는 서버 환경 변수에서 관리합니다.</span></Hint>
  </div>;
}
