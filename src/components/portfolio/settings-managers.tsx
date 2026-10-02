"use client";

import { useState, type FormEvent } from "react";
import { Building2, FolderOpen, Pencil, Plus, Search, Trash2 } from "lucide-react";
import type { AccountDto, AssetDto, PortfolioDto } from "@/lib/contracts";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState, ErrorNotice, SubmitButton } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/input";
import { request, useMutation } from "./api";
import { DeleteDialog } from "./delete-dialog";
import { accountTypeLabels, assetClassLabels } from "./format";
import { AssetName, Hint, Panel, TableWrap } from "./shared";
import { useWorkspace } from "./workspace-context";

export function AccountManagement() {
  const { data } = useWorkspace();
  const [account, setAccount] = useState<AccountDto | "new" | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioDto | "new" | null>(null);
  const [removing, setRemoving] = useState<{ title: string; description: string; url: string } | null>(null);
  return <div className="view-stack"><Panel title="내 계좌" description="일반·ISA·연금 계좌와 소속 포트폴리오를 관리합니다." action={<Button size="sm" onClick={() => setAccount("new")}><Plus />계좌 추가</Button>}>
    {!data.accounts.length ? <EmptyState title="첫 계좌를 만들어 주세요" description="자동 계좌 연결 없이 거래를 직접 입력하거나 파일로 가져올 수 있습니다." action={<Button onClick={() => setAccount("new")}><Building2 />새 계좌 만들기</Button>} /> : <TableWrap><table><thead><tr><th>계좌명</th><th>금융기관</th><th>종류</th><th>기본 통화</th><th>포트폴리오</th><th>관리</th></tr></thead><tbody>{data.accounts.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.institution || "직접 관리"}</td><td><span className="badge">{accountTypeLabels[item.accountType] || item.accountType}</span></td><td>{item.currency}</td><td>{data.portfolios.find((group) => group.id === item.portfolioId)?.name ?? "미지정"}</td><td><div className="row-actions"><Button variant="ghost" size="icon" aria-label={`${item.name} 계좌 수정`} onClick={() => setAccount(item)}><Pencil /></Button><Button variant="ghost" size="icon" aria-label={`${item.name} 계좌 삭제`} onClick={() => setRemoving({ title: "계좌를 삭제할까요?", description: `‘${item.name}’ 계좌를 삭제합니다. 거래 또는 파일 가져오기 감사 이력이 전혀 없는 빈 계좌만 삭제할 수 있습니다. 거래를 삭제했더라도 감사 이력이 남아 있으면 계좌는 보존됩니다.`, url: `/api/accounts/${item.id}` })}><Trash2 /></Button></div></td></tr>)}</tbody></table></TableWrap>}
  </Panel><Panel title="포트폴리오" description="목적에 맞게 계좌를 묶어 통합 필터로 분석하세요." action={<Button variant="outline" size="sm" onClick={() => setPortfolio("new")}><Plus />포트폴리오 추가</Button>}>
    {!data.portfolios.length ? <EmptyState title="계좌를 목적별로 묶어 보세요" description="예: 장기 투자, 은퇴 준비, 자녀 교육. 계좌 수정에서 포트폴리오를 연결할 수 있습니다." /> : <div className="portfolio-list">{data.portfolios.map((item) => <div key={item.id}><span className="feature-icon"><FolderOpen /></span><div><h3>{item.name}</h3><p>연결된 계좌 {data.accounts.filter((account) => account.portfolioId === item.id).length}개</p></div><div className="row-actions"><Button variant="ghost" size="icon" aria-label={`${item.name} 포트폴리오 수정`} onClick={() => setPortfolio(item)}><Pencil /></Button><Button variant="ghost" size="icon" aria-label={`${item.name} 포트폴리오 삭제`} onClick={() => setRemoving({ title: "포트폴리오를 삭제할까요?", description: `‘${item.name}’ 묶음만 삭제합니다. 연결된 계좌는 소속이 미지정으로 바뀌며, 계좌와 모든 거래 기록은 그대로 보존됩니다.`, url: `/api/portfolios/${item.id}` })}><Trash2 /></Button></div></div>)}</div>}
  </Panel><Hint>계좌 내에서 KRW와 USD 현금을 모두 기록할 수 있습니다. 기본 통화는 계좌의 표시·입력 기준이며 자동 환전을 실행하지 않습니다. 상단 계좌·포트폴리오 필터는 모든 분석 화면에 함께 적용됩니다.</Hint>
    {account && <AccountEditor account={account === "new" ? undefined : account} onClose={() => setAccount(null)} />}
    {portfolio && <PortfolioEditor portfolio={portfolio === "new" ? undefined : portfolio} onClose={() => setPortfolio(null)} />}
    {removing && <DeleteDialog {...removing} onClose={() => setRemoving(null)} />}
  </div>;
}

function AccountEditor({ account, onClose }: { account?: AccountDto; onClose: () => void }) {
  const { data, refresh, notify } = useWorkspace();
  const mutation = useMutation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const text = (key: string) => String(values.get(key) ?? "").trim();
    const payload = { name: text("name"), institution: text("institution"), accountType: text("accountType"), currency: text("currency"), portfolioId: text("portfolioId") || null };
    await mutation.run(() => request(`/api/accounts${account ? `/${account.id}` : ""}`, { method: account ? "PATCH" : "POST", body: JSON.stringify(payload) }), () => { notify("계좌를 저장했습니다."); refresh(); onClose(); });
  }
  return <Dialog title={account ? "계좌 수정" : "계좌 추가"} onClose={onClose}><form className="form-stack" onSubmit={submit}><div className="form-grid">
    <Field label="계좌 이름" required className="full-width"><Input name="name" defaultValue={account?.name ?? ""} placeholder="예: 나의 장기 투자 계좌" required maxLength={80} /></Field>
    <Field label="금융기관" className="full-width"><Input name="institution" defaultValue={account?.institution ?? ""} placeholder="예: 직접 관리 또는 증권사 이름" maxLength={100} /></Field>
    <Field label="계좌 종류" required><Select name="accountType" defaultValue={account?.accountType ?? "GENERAL"}>{Object.entries(accountTypeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
    <Field label="계좌 기본 통화" required><Select name="currency" defaultValue={account?.currency ?? data.user.baseCurrency}><option value="KRW">KRW</option><option value="USD">USD</option></Select></Field>
    <Field label="소속 포트폴리오" className="full-width"><Select name="portfolioId" defaultValue={account?.portfolioId ?? ""}><option value="">미지정</option>{data.portfolios.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field>
  </div><ErrorNotice message={mutation.error} /><div className="form-actions"><Button variant="outline" onClick={onClose}>취소</Button><SubmitButton pending={mutation.pending}>계좌 저장하기</SubmitButton></div></form></Dialog>;
}

function PortfolioEditor({ portfolio, onClose }: { portfolio?: PortfolioDto; onClose: () => void }) {
  const { refresh, notify } = useWorkspace();
  const mutation = useMutation();
  return <Dialog title={portfolio ? "포트폴리오 수정" : "포트폴리오 추가"} onClose={onClose}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); const name = String(new FormData(event.currentTarget).get("name") ?? "").trim(); void mutation.run(() => request(`/api/portfolios${portfolio ? `/${portfolio.id}` : ""}`, { method: portfolio ? "PATCH" : "POST", body: JSON.stringify({ name }) }), () => { notify("포트폴리오를 저장했습니다."); refresh(); onClose(); }); }}><Field label="포트폴리오 이름" required><Input name="name" required maxLength={80} defaultValue={portfolio?.name ?? ""} placeholder="예: 은퇴 준비" /></Field><ErrorNotice message={mutation.error} /><div className="form-actions"><Button variant="outline" onClick={onClose}>취소</Button><SubmitButton pending={mutation.pending}>포트폴리오 저장하기</SubmitButton></div></form></Dialog>;
}

export function AssetManagement() {
  const { data } = useWorkspace();
  const [editing, setEditing] = useState<AssetDto | "new" | null>(null);
  const [search, setSearch] = useState("");
  const assets = data.assets.filter((asset) => `${asset.name} ${asset.symbol} ${asset.exchange}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="view-stack"><Panel title="종목 관리" description="같은 코드라도 거래소·통화가 다르면 별도의 자산입니다." action={<Button size="sm" onClick={() => setEditing("new")}><Plus />종목 추가</Button>}>
    <div className="table-toolbar"><div className="search-field"><Search size={17} /><Input aria-label="등록 종목 검색" placeholder="종목 이름, 코드, 거래소 검색" value={search} onChange={(event) => setSearch(event.target.value)} /></div></div>
    {!assets.length ? <EmptyState title="등록된 종목이 없어요" description="주식·ETF·가상자산·사용자 자산을 직접 등록해 관리하세요." /> : <TableWrap><table><thead><tr><th>종목</th><th>자산군</th><th>통화</th><th>국가 / 섹터</th><th>가격 데이터</th><th>관리</th></tr></thead><tbody>{assets.map((asset) => <tr key={asset.id}><td><AssetName asset={asset} /></td><td>{assetClassLabels[asset.assetClass]}</td><td>{asset.currency}</td><td>{asset.country || "미분류"}<small className="cell-sub">{asset.sector || "미분류"}</small></td><td><span className="badge">{asset.provider === "ALPHA_VANTAGE" ? "Alpha Vantage" : "수동 관리"}</span></td><td><Button variant="ghost" size="icon" aria-label={`${asset.name} 종목 수정`} onClick={() => setEditing(asset)}><Pencil /></Button></td></tr>)}</tbody></table></TableWrap>}
  </Panel><Hint>파일 가져오기에서 새로 발견한 종목의 기본 자산군은 주식입니다. ETF·가상자산·사용자 자산은 미리 정확한 자산군으로 등록하세요. Alpha Vantage는 서버의 이용 권한 설정과 지원 심볼이 필요하며 모든 거래소의 가격을 제공하지 않습니다.</Hint>{editing && <AssetEditor asset={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />}</div>;
}

function AssetEditor({ asset, onClose }: { asset?: AssetDto; onClose: () => void }) {
  const { refresh, notify } = useWorkspace();
  const mutation = useMutation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const text = (key: string) => String(values.get(key) ?? "").trim();
    const payload = { symbol: text("symbol"), name: text("name"), exchange: text("exchange"), currency: text("currency"), assetClass: text("assetClass"), country: text("country") || null, sector: text("sector") || null, provider: text("provider") };
    await mutation.run(() => request(`/api/assets${asset ? `/${asset.id}` : ""}`, { method: asset ? "PATCH" : "POST", body: JSON.stringify(payload) }), () => { notify("종목을 저장했습니다."); refresh(); onClose(); });
  }
  return <Dialog title={asset ? "종목 수정" : "종목 추가"} onClose={onClose} wide><form className="form-stack" onSubmit={submit}><div className="form-grid">
    <Field label="종목 이름" required className="full-width"><Input name="name" defaultValue={asset?.name ?? ""} required maxLength={120} placeholder="자산의 표시 이름" /></Field>
    <Field label="종목 코드" required><Input name="symbol" defaultValue={asset?.symbol ?? ""} required maxLength={40} placeholder="예: AAPL 또는 내 자산 코드" /></Field>
    <Field label="거래소" required><Input name="exchange" defaultValue={asset?.exchange ?? ""} required maxLength={40} placeholder="예: NASDAQ, KRX, MANUAL" /></Field>
    <Field label="자산군" required><Select name="assetClass" defaultValue={asset?.assetClass ?? "STOCK"}>{Object.entries(assetClassLabels).filter(([key]) => key !== "CASH").map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
    <Field label="종목 통화" required><Select name="currency" defaultValue={asset?.currency ?? "KRW"}><option value="KRW">KRW</option><option value="USD">USD</option></Select></Field>
    <Field label="국가"><Input name="country" defaultValue={asset?.country ?? ""} placeholder="예: 미국, 대한민국" maxLength={80} /></Field>
    <Field label="섹터"><Input name="sector" defaultValue={asset?.sector ?? ""} placeholder="예: 정보기술, 금융" maxLength={80} /></Field>
    <Field label="가격 데이터 제공자" className="full-width" required><Select name="provider" defaultValue={asset?.provider ?? "MANUAL"}><option value="MANUAL">수동 관리 · 가격 직접 입력</option><option value="ALPHA_VANTAGE">Alpha Vantage · 별도 이용 권한 필요</option></Select></Field>
  </div><ErrorNotice message={mutation.error} /><div className="form-actions"><Button variant="outline" onClick={onClose}>취소</Button><SubmitButton pending={mutation.pending}>종목 저장하기</SubmitButton></div></form></Dialog>;
}
