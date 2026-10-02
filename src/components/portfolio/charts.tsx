"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Currency } from "@/lib/domain";
import type { WorkspaceData, DividendAggregate, GoalDto } from "@/lib/contracts";
import { colors, money, number, percent } from "./format";
import { EmptyState } from "@/components/ui/feedback";

const grid = { stroke: "#edf0f0", strokeDasharray: "4 4", vertical: false };
const tick = { fill: "#849094", fontSize: 11 };
const tooltipStyle = { background: "#ffffff", border: "1px solid #e4ebe8", borderRadius: 12, fontSize: 12, boxShadow: "0 8px 30px #173e5812" };
const asNumber = (value: unknown) => typeof value === "string" || typeof value === "number" ? number(value) : null;

export function ValueChart({ history, currency, benchmark = false }: {
  history: WorkspaceData["analysis"]["history"]; currency: Currency; benchmark?: boolean;
}) {
  if (!history.length || history.every((point) => point.value === null)) return <EmptyState title="평가 흐름을 계산할 수 없어요" description="거래를 기록하고 필요한 가격과 환율을 등록하면 차트가 나타납니다. 누락 값은 0으로 채우지 않습니다." />;
  const data = history.map((point) => ({ date: point.date, value: number(point.value), contributions: number(point.netContributions), benchmark: number(point.benchmarkValue) }));
  return <div className="chart chart-value" role="img" aria-label="실제 평가액과 누적 순입금. 가상 PRICE 벤치마크는 동일 외부 입출금을 적용하며 배당 재투자를 포함하지 않습니다."><ResponsiveContainer width="100%" height="100%" minWidth={0}>
    <AreaChart data={data} margin={{ top: 15, right: 12, left: 8, bottom: 0 }}>
      <defs><linearGradient id="value-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#188674" stopOpacity={0.19} /><stop offset="100%" stopColor="#188674" stopOpacity={0.01} /></linearGradient></defs>
      <CartesianGrid {...grid} /><XAxis dataKey="date" tickFormatter={(date: string) => date.slice(5).replace("-", ".")} minTickGap={38} tick={tick} axisLine={false} tickLine={false} dy={10} />
      <YAxis tickFormatter={(value: number) => money(value, currency, true)} tick={tick} axisLine={false} tickLine={false} width={75} />
      <Tooltip contentStyle={tooltipStyle} formatter={(value, name) => [money(asNumber(value), currency), name]} labelFormatter={(label) => `${label}`} />
      <Area type="monotone" dataKey="value" name="실제 총 평가액 (배당 반영)" stroke="#15806f" fill="url(#value-fill)" strokeWidth={2.5} connectNulls={false} animationDuration={450} />
      <Area type="monotone" dataKey="contributions" name="누적 순입금" stroke="#a4b1ba" fill="transparent" strokeWidth={1.5} strokeDasharray="5 5" connectNulls={false} />
      {benchmark && <Area type="monotone" dataKey="benchmark" name="동일 외부 입출금 · PRICE (배당 재투자 제외)" stroke="#daa95b" fill="transparent" strokeWidth={1.5} connectNulls={false} />}
    </AreaChart>
  </ResponsiveContainer></div>;
}

export function ReturnChart({ history, benchmark, mode = "total" }: {
  history: WorkspaceData["analysis"]["history"]; benchmark: boolean; mode?: "total" | "price";
}) {
  const data = history.map((point) => ({
    date: point.date,
    portfolio: number(mode === "price" ? point.portfolioPriceTwr : point.twr),
    benchmark: number(point.benchmarkReturn),
  }));
  if (!data.length || data.every((point) => point.portfolio === null)) {
    return <EmptyState title={mode === "price" ? "배당 제외 일별 수익률을 표시할 수 없어요" : "총수익 TWR을 표시할 수 없어요"}
      description={mode === "price" ? "하단 비교 카드의 기간 수익률을 확인하세요. 일별 배당 제외 값이 없으면 배당 포함 TWR로 대체하지 않습니다." : "자본·가격·환율이 부족하거나 수익률을 정의할 수 없는 구간입니다. 누락값은 0%가 아닙니다."} />;
  }
  const priceComparison = mode === "price" && benchmark;
  return <div className="chart" role="img" aria-label={mode === "price" ? "배당 제외 포트폴리오 TWR와 PRICE 벤치마크 비교 차트" : "포트폴리오 총수익 TWR 차트 · 배당 포함 · PRICE 비교와 별도"}><ResponsiveContainer width="100%" height="100%" minWidth={0}>
    <LineChart data={data} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}><CartesianGrid {...grid} /><XAxis dataKey="date" tickFormatter={(value: string) => value.slice(5)} minTickGap={40} tick={tick} axisLine={false} tickLine={false} /><YAxis tickFormatter={(value: number) => percent(value)} tick={tick} axisLine={false} tickLine={false} width={70} /><Tooltip contentStyle={tooltipStyle} formatter={(value, name) => [percent(asNumber(value)), name]} /><Legend iconType="plainline" wrapperStyle={{ fontSize: 12, paddingTop: 18 }} /><Line dataKey="portfolio" name={mode === "price" ? "포트폴리오 TWR (배당 제외)" : "포트폴리오 총수익 TWR (배당 포함)"} stroke="#15806f" strokeWidth={2.5} dot={false} connectNulls={false} />{priceComparison && <Line dataKey="benchmark" name="벤치마크 PRICE (배당 제외)" stroke="#d5a85f" strokeWidth={2} dot={false} connectNulls={false} />}</LineChart>
  </ResponsiveContainer></div>;
}

export function AllocationDonut({ data, currency, total }: { data: { name: string; value: string | null }[]; currency: Currency; total: string | null }) {
  const nav = number(total);
  if (nav === null || nav <= 0 || data.some((point) => number(point.value) === null)) {
    return <EmptyState title="자산 배분을 계산할 수 없어요" description="전체 평가액이 양수이고 모든 항목의 평가가 가능할 때 표시됩니다. 누락한 자산을 제외한 채 비중을 다시 계산하지 않습니다." />;
  }
  const points = data.flatMap((point) => {
    const value = number(point.value);
    return value !== null && value > 0 ? [{ name: point.name, value }] : [];
  });
  if (!points.length) return <EmptyState title="자산 배분을 기다리고 있어요" description="양수의 평가액이 있는 보유 자산이 필요합니다." />;
  return <div className="donut-wrap"><div className="donut-chart" role="img" aria-label="양수 평가액 기준 자산 배분 원형 차트"><ResponsiveContainer width="100%" height="100%" minWidth={0}><PieChart><Pie data={points} innerRadius="70%" outerRadius="91%" paddingAngle={3} dataKey="value" stroke="none" cornerRadius={4}>{points.map((point, index) => <Cell key={point.name} fill={colors[index % colors.length]} />)}</Pie><Tooltip contentStyle={tooltipStyle} formatter={(value) => money(asNumber(value), currency)} /></PieChart></ResponsiveContainer><div className="donut-center"><small>전체 평가액</small><strong>{money(total, currency, true)}</strong></div></div></div>;
}

export function DividendChart({ rows, currency }: { rows: DividendAggregate[]; currency: Currency }) {
  if (!rows.length) return <EmptyState title="아직 수령한 배당이 없어요" description="배당 거래를 등록하면 세전·세금·세후 수령액을 확인할 수 있습니다." />;
  const data = rows.map((row) => ({ name: row.key, net: number(row.net), tax: number(row.tax) }));
  return <div className="chart chart-short" role="img" aria-label="기간별 세후 배당과 배당세 막대 차트"><ResponsiveContainer width="100%" height="100%" minWidth={0}><BarChart data={data} barSize={26}><CartesianGrid {...grid} /><XAxis dataKey="name" tick={tick} axisLine={false} tickLine={false} /><YAxis tickFormatter={(value: number) => money(value, currency, true)} tick={tick} axisLine={false} tickLine={false} width={68} /><Tooltip contentStyle={tooltipStyle} formatter={(value, name) => [money(asNumber(value), currency), name]} /><Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} /><Bar dataKey="net" name="세후 배당" stackId="dividend" fill="#298f7c" radius={[0, 0, 0, 0]} /><Bar dataKey="tax" name="배당세" stackId="dividend" fill="#b2d8cb" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div>;
}

export function GoalChart({ goal }: { goal: GoalDto }) {
  const data = goal.projection.map((point) => ({ year: point.year, value: number(point.value), contributions: number(point.contributions) }));
  return <div className="chart chart-short" role="img" aria-label={`${goal.name}의 가정 기반 예상 자산과 누적 납입액`}><ResponsiveContainer width="100%" height="100%" minWidth={0}><AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}><CartesianGrid {...grid} /><XAxis dataKey="year" tickFormatter={(value: number) => `${value}년`} tick={tick} axisLine={false} tickLine={false} /><YAxis tickFormatter={(value: number) => money(value, goal.currency, true)} tick={tick} axisLine={false} tickLine={false} width={70} /><Tooltip contentStyle={tooltipStyle} formatter={(value, name) => [money(asNumber(value), goal.currency), name]} labelFormatter={(label) => `${label}년 후`} /><Area dataKey="value" name="가정 기반 예상 자산" stroke="#16826e" fill="#e5f3ed" strokeWidth={2} /><Area dataKey="contributions" name="누적 납입액" stroke="#a7b5bf" fill="transparent" strokeDasharray="5 4" /></AreaChart></ResponsiveContainer></div>;
}
