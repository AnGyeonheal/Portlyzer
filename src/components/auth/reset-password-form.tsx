"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { ErrorNotice, SubmitButton } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/input";
import { Brand, Panel } from "@/components/portfolio/shared";
import { useMutation } from "@/components/portfolio/api";
import { assertAuthResult } from "./auth-errors";

export function ResetPasswordForm({ token, enabled }: { token: string; enabled: boolean }) {
  const [done, setDone] = useState(false);
  const mutation = useMutation();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await mutation.run(async () => {
      const newPassword = String(values.get("password"));
      if (newPassword !== values.get("confirmation")) throw new Error("새 비밀번호가 일치하지 않습니다.");
      assertAuthResult(await authClient.resetPassword({ token, newPassword }));
    }, () => setDone(true));
  }
  return <main className="mx-auto max-w-lg p-6"><Brand /><div className="mt-8"><Panel title="비밀번호 재설정">
    <div className="p-6 form-stack">{done ? <p role="status" className="notice notice-info">비밀번호가 변경되었고 기존 로그인 세션은 모두 종료되었습니다. 새 비밀번호로 로그인해 주세요.</p>
      : !enabled ? <ErrorNotice message="이 환경에서는 이메일 복구가 설정되지 않았습니다. 관리자에게 문의해 주세요." />
        : !token ? <ErrorNotice message="사용할 수 없는 재설정 링크입니다. 로그인 화면에서 새 링크를 요청해 주세요." />
        : <form className="form-stack" onSubmit={submit}>
          <Field label="새 비밀번호" required><Input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={mutation.pending} /></Field>
          <Field label="새 비밀번호 확인" required><Input name="confirmation" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={mutation.pending} /></Field>
          <ErrorNotice message={mutation.error} /><SubmitButton pending={mutation.pending}>비밀번호 재설정하기</SubmitButton>
        </form>}
      <Button asChild variant="outline"><Link href="/login">로그인으로 돌아가기</Link></Button>
    </div></Panel></div></main>;
}
