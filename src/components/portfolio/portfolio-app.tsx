"use client";

import { useEffect, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Activity, ArrowUpRight, BriefcaseBusiness, CalendarDays, ChartNoAxesCombined, ChevronDown, ChevronRight, CircleHelp, CircleUserRound, FileText, LayoutDashboard, LogOut, Menu, PieChart, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Target, Wallet } from "lucide-react";
import type { WorkspaceData } from "@/lib/contracts";
import type { Currency } from "@/lib/domain";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorNotice, Loading, Toast } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/input";
import { Allocation } from "./allocation";
import { ApiError, errorMessage, request } from "./api";
import { Dashboard } from "./dashboard";
import { Dividends } from "./dividends";
import { dateTime, issueText, today } from "./format";
import { Goals } from "./goals";
import { Holdings } from "./holdings";
import { Performance } from "./performance";
import { Settings } from "./settings";
import { Brand } from "./shared";
import { TradeAnalysis } from "./trade-analysis";
import { TransactionEditor } from "./transaction-editor";
import { Transactions } from "./transactions";
import { WorkspaceContext, type Filters, type View } from "./workspace-context";

const navigation: { id: View; label: string; description: string; icon: ComponentType<{ size?: number; className?: string }> }[] = [
  { id: "dashboard", label: "대시보드", description: "흩어진 투자를 한눈에, 나의 자산 흐름을 확인하세요.", icon: LayoutDashboard },
  { id: "holdings", label: "보유 자산", description: "내가 가진 자산과 현금, 그 안의 가치를 살펴보세요.", icon: Wallet },
  { id: "performance", label: "수익률 분석", description: "입출금과 성과를 구분해 진짜 투자 결과를 읽어보세요.", icon: ChartNoAxesCombined },
  { id: "allocation", label: "자산 배분", description: "현재의 균형을 살펴보고 나만의 목표 비중을 정하세요.", icon: PieChart },
  { id: "dividends", label: "배당 관리", description: "다가올 배당부터 실제 수령까지, 빠짐없이 기록하세요.", icon: CalendarDays },
  { id: "transactions", label: "거래 내역", description: "투자의 모든 순간을 기록하고 연결하세요.", icon: FileText },
  { id: "trades", label: "매매 분석", description: "지난 선택을 돌아보며 나만의 투자 원칙을 쌓으세요.", icon: Activity },
  { id: "goals", label: "목표 관리", description: "오늘의 작은 기록이 내일의 목표에 가까워지도록.", icon: Target },
  { id: "settings", label: "설정", description: "내 계좌와 데이터, 나에게 맞는 분석 기준을 관리하세요.", icon: Settings2 },
];
const views: Record<View, ComponentType> = { dashboard: Dashboard, holdings: Holdings, performance: Performance, allocation: Allocation, dividends: Dividends, transactions: Transactions, trades: TradeAnalysis, goals: Goals, settings: Settings };

export function PortfolioApp({ initialUser }: { initialUser: { name: string; baseCurrency: Currency; isDemo: boolean } }) {
  const router = useRouter();
  const [view, setView] = useState<View>("dashboard");
  const [settingsTab, setSettingsTab] = useState<"market" | undefined>(undefined);
  const [filters, setFilters] = useState<Filters>(() => ({ from: `${today().slice(0, 4)}-01-01`, to: today(), currency: initialUser.baseCurrency, accountId: "all", portfolioId: "all" }));
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ key: string; data: WorkspaceData } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string; unauthorized: boolean } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [newTransaction, setNewTransaction] = useState(false);
  const [help, setHelp] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const query = new URLSearchParams({ ...filters }).toString();
  const requestKey = `${query}:${version}`;
  const currentError = failure?.key === requestKey ? failure : null;
  const loading = result?.key !== requestKey && !currentError;
  const data = result?.data;
  const viewer = data?.user ?? initialUser;
  const active = navigation.find((item) => item.id === view)!;
  const ActiveView = views[view];
  const invalidRange = !filters.from || !filters.to || filters.from > filters.to;
  const contextFilters = invalidRange && data ? { ...filters, from: data.filters.from, to: data.filters.to } : filters;

  useEffect(() => {
    if (invalidRange) return;
    const controller = new AbortController();
    request<WorkspaceData>(`/api/workspace?${query}`, { signal: controller.signal })
      .then((workspace) => { if (!controller.signal.aborted) setResult({ key: requestKey, data: workspace }); })
      .catch((cause) => {
        if (!controller.signal.aborted) setFailure({ key: requestKey, message: errorMessage(cause), unauthorized: cause instanceof ApiError && (cause.code === "UNAUTHORIZED" || cause.code === "401") });
      });
    return () => controller.abort();
  }, [query, requestKey, invalidRange]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  function navigate(next: View) {
    setSettingsTab(undefined);
    setView(next);
    setMobileOpen(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function refresh() { setVersion((current) => current + 1); }
  async function signOut() {
    setSigningOut(true);
    setAuthError(null);
    try {
      const response = await authClient.signOut();
      if (response.error) throw new Error("로그아웃하지 못했습니다. 다시 시도해 주세요.");
      router.replace("/login");
      router.refresh();
    } catch (cause) {
      setAuthError(errorMessage(cause));
      setSigningOut(false);
    }
  }

  const nav = (mobile = false) => <nav aria-label={mobile ? "모바일 전체 메뉴" : "주요 메뉴"} className="main-navigation">{navigation.map((item, index) => <div key={item.id}>{index === 0 && <span className="nav-group-label">나의 포트폴리오</span>}{index === 5 && <span className="nav-group-label">기록과 계획</span>}{index === 8 && <div className="nav-divider" />}<button aria-current={view === item.id ? "page" : undefined} className={view === item.id ? "active" : ""} onClick={() => navigate(item.id)}><item.icon size={19} /><span>{item.label}</span>{view === item.id && <span className="nav-active-dot" />}</button></div>)}</nav>;

  return <div className="app-shell">
    <a href="#main-content" className="skip-link">본문으로 바로가기</a>
    <aside className="sidebar"><Link className="sidebar-brand" href="/" aria-label="Portlyzer 대시보드"><Brand /></Link><span className="workspace-label"><span className="workspace-symbol"><BriefcaseBusiness size={15} /></span>나의 투자 공간<span className="badge badge-small">개인</span></span>{nav()}<div className="sidebar-bottom"><div className="sidebar-note"><span className="sidebar-note-icon"><Sparkles size={17} /></span><strong>기록이 쌓이면,<br />투자가 선명해져요.</strong><p>나만의 속도로, 꾸준히.</p><button onClick={() => setHelp(true)}>Portlyzer 사용 가이드<ArrowUpRight size={14} /></button></div><div className="sidebar-user"><span className="user-avatar">{viewer.name?.slice(0, 1) || <CircleUserRound size={20} />}</span><div><strong>{viewer.name || "내 계정"}{viewer.isDemo && <span className="badge badge-demo">DEMO</span>}</strong><small>{viewer.isDemo ? "가상 데이터 체험 중" : "개인 투자 워크스페이스"}</small></div><Button variant="ghost" size="icon" onClick={signOut} disabled={signingOut} aria-label="로그아웃"><LogOut size={17} /></Button></div></div></aside>
    <div className="main-shell"><header className="topbar"><div className="topbar-left"><Button variant="ghost" size="icon" className="mobile-menu-button" aria-label="전체 메뉴 열기" onClick={() => setMobileOpen(true)}><Menu /></Button><span className="breadcrumb"><span>나의 투자 공간</span><ChevronRight size={13} /><strong>{active.label}</strong></span></div><div className="topbar-actions">{viewer.isDemo && <span className="badge badge-demo header-demo">DEMO · 가상 데이터</span>}<span className="private-status"><ShieldCheck size={14} />나만의 안전한 기록</span><Button variant="ghost" size="icon" aria-label="사용 가이드" onClick={() => setHelp(true)}><CircleHelp /></Button><span className="header-avatar" aria-hidden="true">{viewer.name?.slice(0, 1) || "P"}</span></div></header>
      <main id="main-content" className="main-content"><div className="page-heading"><div><span className="eyebrow"><span /> MY INVESTMENT JOURNAL</span><h1>{active.label}{view === "dashboard" && <span className="greeting-dot" />}</h1><p>{active.description}</p></div><div className="page-heading-actions"><Button variant="outline" size="icon" aria-label="워크스페이스 새로고침" disabled={loading || invalidRange} onClick={refresh}><RefreshCw className={loading ? "animate-spin" : ""} /></Button><Button onClick={() => setNewTransaction(true)} disabled={!data || loading || !!currentError || invalidRange}><Plus />거래 추가</Button></div></div>
        <div className="filter-bar"><div className="filter-dates"><CalendarDays size={16} /><label><span className="sr-only">조회 시작일</span><Input aria-label="조회 시작일" type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label><span className="date-separator">–</span><label><span className="sr-only">조회 종료일</span><Input aria-label="조회 종료일" type="date" value={filters.to} min={filters.from || undefined} max={today()} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label></div><span className="filter-divider" /><label className="filter-select"><BriefcaseBusiness size={15} /><span className="sr-only">포트폴리오 필터</span><Select aria-label="포트폴리오 필터" value={filters.portfolioId} onChange={(event) => setFilters({ ...filters, portfolioId: event.target.value, accountId: "all" })}><option value="all">모든 포트폴리오</option>{data?.portfolios.map((portfolio) => <option value={portfolio.id} key={portfolio.id}>{portfolio.name}</option>)}</Select></label><label className="filter-select"><Wallet size={15} /><span className="sr-only">계좌 필터</span><Select aria-label="계좌 필터" value={filters.accountId} onChange={(event) => setFilters({ ...filters, accountId: event.target.value })}><option value="all">모든 계좌</option>{data?.accounts.filter((account) => filters.portfolioId === "all" || account.portfolioId === filters.portfolioId).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</Select></label><label className="filter-currency"><span className="sr-only">표시 통화</span><Select aria-label="표시 통화" value={filters.currency} onChange={(event) => setFilters({ ...filters, currency: event.target.value as Currency })}><option value="KRW">₩ KRW</option><option value="USD">$ USD</option></Select></label></div>
        <ErrorNotice message={authError} />
        {invalidRange && <ErrorNotice message="올바른 조회 기간을 입력해 주세요. 시작일은 종료일보다 늦을 수 없습니다." />}
        {loading && !invalidRange && <div className="workspace-loading"><Loading label={data ? "선택한 조건으로 다시 계산하고 있어요…" : "나의 포트폴리오를 불러오고 있어요…"} /><div className="skeleton-metrics">{[0, 1, 2, 3].map((item) => <div key={item} />)}</div><div className="skeleton-chart" /></div>}
        {currentError && !invalidRange && <div className="workspace-error"><ErrorNotice message={currentError.message} /><Button onClick={currentError.unauthorized ? () => { router.replace("/login"); router.refresh(); } : refresh}>{currentError.unauthorized ? "다시 로그인" : "다시 불러오기"}</Button></div>}
        {data && <WorkspaceContext.Provider value={{ data, filters: contextFilters, setFilters, refresh, notify: setToast, navigate, openTransaction: () => setNewTransaction(true) }}><div hidden={loading || !!currentError || invalidRange} aria-busy={loading}><DataQuality data={data} onOpenSettings={() => { navigate("settings"); setSettingsTab("market"); }} />{view === "settings" ? <Settings key={settingsTab ?? "default"} initialTab={settingsTab} /> : <ActiveView />}<footer className="workspace-footer"><span><span className="status-dot" />마지막 계산 {dateTime(data.computedAt)}</span><span>투자의 판단은 나에게, 기록의 정리는 Portlyzer에.</span></footer></div>{newTransaction && <TransactionEditor onClose={() => setNewTransaction(false)} />}</WorkspaceContext.Provider>}
      </main>
    </div>
    <nav className="mobile-bottom-nav" aria-label="빠른 이동">{navigation.filter((item) => ["dashboard", "holdings", "dividends", "transactions"].includes(item.id)).map((item) => <button key={item.id} className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined} onClick={() => navigate(item.id)}><item.icon size={20} /><span>{item.label}</span></button>)}<button onClick={() => setMobileOpen(true)}><Menu size={20} /><span>전체</span></button></nav>
    {mobileOpen && <Dialog title="전체 메뉴" onClose={() => setMobileOpen(false)}><div className="mobile-navigation-content">{nav(true)}<Button variant="outline" onClick={signOut} disabled={signingOut}><LogOut />로그아웃</Button></div></Dialog>}
    {help && <Dialog title="Portlyzer 사용 가이드" description="내 기록에서 출발하는 투자 관리" onClose={() => setHelp(false)}><div className="guide-steps"><div><span>1</span><section><h3>계좌와 종목을 등록하세요</h3><p>설정에서 일반·ISA·연금 계좌와 투자 종목을 만들고 포트폴리오로 묶을 수 있습니다.</p></section></div><div><span>2</span><section><h3>현금과 거래를 기록하세요</h3><p>입금부터 매매·배당·환전까지 직접 기록하거나 CSV·XLSX를 가져오세요. 파일의 열을 연결하고 오류와 중복을 확인한 후 확정합니다.</p></section></div><div><span>3</span><section><h3>가격과 환율을 확인하세요</h3><p>누락한 데이터는 0으로 채우지 않습니다. 설정의 가격·환율 탭에서 직접 입력하거나 이용 권한이 있는 공급자로 수집하세요.</p></section></div><div><span>4</span><section><h3>필터 하나로 모든 관점을 연결하세요</h3><p>기간, 계좌, 포트폴리오, 통화를 선택하면 자산·수익률·배당·목표 실적에 함께 적용됩니다. DEMO 표시는 가상 데이터 체험 계정을 의미합니다.</p></section></div></div><Button className="w-full mt-6" onClick={() => setHelp(false)}>알겠어요</Button></Dialog>}
    {toast && <Toast message={toast} onClose={() => setToast(null)} />}
  </div>;
}

function DataQuality({ data, onOpenSettings }: { data: WorkspaceData; onOpenSettings: () => void }) {
  const issues = data.analysis.issues;
  if (!issues.length) return <div className="data-health"><span className="status-dot" /><span>내 기록을 바탕으로 계산했어요.</span><span>원가 기준 {data.user.costMethod === "FIFO" ? "선입선출" : "이동평균"}<span className="health-separator">·</span>표시 통화 {data.filters.currency}</span></div>;
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  return <details className="data-issues"><summary><span className="issue-indicator" /><span><strong>데이터 확인이 필요해요</strong><span className="issues-count">{issues.length}건{errorCount ? ` · 계산 제한 ${errorCount}건` : ""}</span></span><span className="issues-summary">누락된 값은 0으로 계산하지 않습니다.</span><ChevronDown size={16} /></summary><div className="data-issues-content"><ul>{issues.slice(0, 80).map((issue, index) => <li key={`${issue.code}-${index}`}><span className={`badge ${issue.severity === "error" ? "badge-error" : "badge-warning"}`}>{issue.severity === "error" ? "확인 필요" : "참고"}</span><span title={issue.message}>{issueText(issue)}{issue.assetId && <small>{data.assets.find((asset) => asset.id === issue.assetId)?.symbol || issue.assetId}</small>}{issue.date && <small>{issue.date}</small>}<small className="issue-code">{issue.code}</small></span></li>)}</ul>{issues.length > 80 && <p className="text-muted text-sm">외 {issues.length - 80}건. 설정에서 계산에 사용된 전체 관측 근거를 확인하세요.</p>}<Button variant="outline" size="sm" onClick={onOpenSettings}>가격·환율 설정 열기<ArrowUpRight /></Button></div></details>;
}
