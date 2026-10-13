"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ChartNoAxesCombined, Check, Eye, EyeOff, Layers3, LoaderCircle, LockKeyhole, Sparkles } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { ErrorNotice } from "@/components/ui/feedback";
import { Brand } from "@/components/portfolio/shared";
import { errorMessage, request } from "@/components/portfolio/api";
import { assertAuthResult } from "./auth-errors";

export function LoginForm({ demoEnabled, recoveryEnabled, requireEmailVerification, verified, verificationError }: {
  demoEnabled: boolean; recoveryEnabled: boolean; requireEmailVerification: boolean; verified: boolean; verificationError: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup" | "reset-request">("login");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState<"auth" | "demo" | null>(null);
  const [error, setError] = useState<string | null>(verificationError ? "인증 링크가 유효하지 않거나 만료되었습니다. 다시 로그인해 새 인증 메일을 요청하세요." : null);
  const [message, setMessage] = useState<string | null>(verified && !verificationError ? "이메일 인증이 완료되었습니다. 로그인해 주세요." : null);

  function finish() {
    router.replace("/");
    router.refresh();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setPending("auth");
    setError(null);
    setMessage(null);
    try {
      const credentials = { email: String(values.get("email")).trim(), password: String(values.get("password")) };
      if (mode === "reset-request") {
        assertAuthResult(await authClient.requestPasswordReset({ email: credentials.email, redirectTo: "/reset-password" }));
        setMessage("등록된 이메일이라면 비밀번호 재설정 안내가 발송됩니다. 메일함과 스팸함을 확인해 주세요.");
        setPending(null);
        return;
      }
      const result = mode === "signup"
        ? await authClient.signUp.email({ ...credentials, name: String(values.get("name")).trim(), callbackURL: "/login?verified=1" })
        : await authClient.signIn.email(credentials);
      assertAuthResult(result);
      if (mode === "signup" && requireEmailVerification) {
        setMessage("메일함에서 이메일 인증을 완료한 뒤 로그인해 주세요.");
        setPending(null);
        return;
      }
      finish();
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(null);
    }
  }

  async function demo() {
    setPending("demo");
    setError(null);
    try {
      await request("/api/demo", { method: "POST", body: JSON.stringify({}) });
      finish();
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(null);
    }
  }

  return (
    <main className="login-layout">
      <section className="login-story" aria-label="Portlyzer 소개">
        <Brand light />
        <div className="login-story-content">
          <span className="eyebrow light"><span /> 투자의 다음 장을, 더 선명하게</span>
          <h1>나의 투자,<br />하나의 시선으로<span>.</span></h1>
          <p>흩어진 계좌는 한곳에, 복잡한 기록은 명확하게.<br />숫자 너머에 있는 나만의 투자 흐름을 발견하세요.</p>
          <div className="login-preview">
            <div className="login-preview-top"><span><Layers3 size={17} /> 나의 포트폴리오</span><span className="badge badge-demo">화면 예시</span></div>
            <div className="login-preview-value">꾸준함이 만드는 변화<ChartNoAxesCombined size={28} /></div>
            <svg viewBox="0 0 430 130" className="login-sparkline" role="img" aria-label="투자 기록을 시각화한 예시 곡선, 실제 수익률이 아닙니다">
              <defs><linearGradient id="login-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#83d6b7" stopOpacity=".25" /><stop offset="100%" stopColor="#83d6b7" stopOpacity="0" /></linearGradient></defs>
              <path d="M0 115 C30 113 35 70 65 81 S100 100 125 75 S145 95 175 59 S205 66 230 51 S270 69 300 35 S330 47 365 20 S405 33 430 5 V130 H0 Z" fill="url(#login-gradient)" />
              <path d="M0 115 C30 113 35 70 65 81 S100 100 125 75 S145 95 175 59 S205 66 230 51 S270 69 300 35 S330 47 365 20 S405 33 430 5" fill="none" stroke="#92e0c1" strokeWidth="3" />
            </svg>
            <div className="login-preview-foot"><span>계좌별 자산</span><span>진짜 수익률</span><span>다가오는 배당</span></div>
          </div>
          <div className="login-benefits"><span><Check size={15} /> 내 기록 중심의 분석</span><span><Check size={15} /> 원화·달러 통합 관리</span></div>
        </div>
        <p className="login-story-footer">더 많이 아는 투자, 더 나다운 선택. <span>PORTLYZER</span></p>
      </section>
      <section className="login-form-side">
        <div className="login-mobile-brand"><Brand /></div>
        <div className="login-form-wrap">
          <div className="login-welcome-icon"><ChartNoAxesCombined size={25} /></div>
          <h2>{mode === "reset-request" ? "비밀번호를 잊으셨나요?" : mode === "login" ? "다시 만나 반가워요" : "나만의 투자 기록을 시작하세요"}</h2>
          <p className="login-description">{mode === "reset-request" ? "가입한 이메일로 재설정 링크를 보내드립니다." : mode === "login" ? "오늘의 포트폴리오를 확인해 볼까요?" : "계좌를 연결하지 않아도 기록을 직접 관리할 수 있어요."}</p>
          <div className="auth-tabs" role="group" aria-label="인증 방식">
            <button type="button" aria-pressed={mode === "login"} disabled={!!pending} onClick={() => { setMode("login"); setError(null); setMessage(null); }}>로그인</button>
            <button type="button" aria-pressed={mode === "signup"} disabled={!!pending} onClick={() => { setMode("signup"); setError(null); setMessage(null); }}>회원가입</button>
          </div>
          <form onSubmit={submit} className="form-stack">
            {mode === "signup" && <Field label="이름" required><Input name="name" autoComplete="name" placeholder="어떻게 불러드릴까요?" required maxLength={80} disabled={!!pending} /></Field>}
            <Field label="이메일" required><Input name="email" type="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} disabled={!!pending} /></Field>
            {mode !== "reset-request" && <Field label="비밀번호" htmlFor="login-password" required hint={mode === "signup" ? "안전한 비밀번호를 12자 이상 입력해 주세요." : undefined}>
              <span className="password-field"><Input id="login-password" name="password" type={showPassword ? "text" : "password"} autoComplete={mode === "signup" ? "new-password" : "current-password"} aria-describedby={mode === "signup" ? "login-password-hint" : undefined} placeholder={mode === "signup" ? "12자 이상 입력" : "비밀번호를 입력하세요"} required minLength={mode === "signup" ? 12 : undefined} maxLength={128} disabled={!!pending} /><button type="button" aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 보기"} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></span>
            </Field>}
            <ErrorNotice message={error} />
            {message && <p className="notice notice-info" role="status">{message}</p>}
            <Button type="submit" size="lg" className="w-full" disabled={!!pending}>{pending === "auth" ? <LoaderCircle className="animate-spin" /> : null}{mode === "reset-request" ? "재설정 메일 보내기" : mode === "login" ? "로그인하기" : "계정 만들기"}<ArrowRight /></Button>
          </form>
          {recoveryEnabled && mode === "login" && <Button variant="ghost" disabled={!!pending} onClick={() => { setMode("reset-request"); setError(null); setMessage(null); }}>비밀번호를 잊으셨나요?</Button>}
          {demoEnabled && <><div className="login-divider"><span>먼저 경험해 보고 싶다면</span></div>
          <Button variant="outline" size="lg" className="demo-button w-full" disabled={!!pending} onClick={demo}>{pending === "demo" ? <LoaderCircle className="animate-spin" /> : <Sparkles />}가입 없이 데모 둘러보기<ArrowRight /></Button>
          <p className="demo-note"><span className="badge badge-demo">DEMO</span> 독립된 가상 데이터로 모든 기능을 둘러보세요.<br />실제 계좌와 연결되지 않으며 투자 성과를 보장하지 않습니다.</p></>}
          <div className="login-security"><LockKeyhole size={14} /><span>내 기록은 내 계정에서만 볼 수 있어요.</span></div>
        </div>
        <footer className="login-footer">© {new Date().getFullYear()} Portlyzer. 나의 투자를 한눈에.</footer>
      </section>
    </main>
  );
}
