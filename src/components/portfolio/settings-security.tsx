"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { assertAuthResult } from "@/components/auth/auth-errors";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorNotice, SubmitButton } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/input";
import { useMutation } from "./api";
import { Hint, Panel } from "./shared";
import { useWorkspace } from "./workspace-context";

export function SecuritySettings() {
  const { data, notify } = useWorkspace();
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const change = useMutation();
  const remove = useMutation();

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    await change.run(async () => {
      const newPassword = String(values.get("newPassword"));
      if (newPassword !== values.get("confirmation")) throw new Error("새 비밀번호가 일치하지 않습니다.");
      assertAuthResult(await authClient.changePassword({ currentPassword: String(values.get("currentPassword")), newPassword, revokeOtherSessions: true }));
    }, () => { form.reset(); notify("비밀번호를 변경하고 다른 기기의 세션을 종료했습니다."); });
  }

  async function deleteUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await remove.run(async () => {
      if (values.get("email") !== data.user.email || values.get("confirm") !== "on") throw new Error("이메일과 영구 삭제 동의를 확인해 주세요.");
      assertAuthResult(await authClient.deleteUser({ password: String(values.get("password")) }));
    }, () => { router.replace("/login"); router.refresh(); });
  }

  if (data.user.isDemo) return <Hint>데모 계정에서는 비밀번호 변경과 계정 탈퇴를 제공하지 않습니다. 실제 기록은 별도로 회원가입한 계정에서 관리하세요.</Hint>;
  return <div className="view-stack">
    <Panel title="비밀번호 변경" description="변경 후 다른 기기의 로그인 세션은 종료됩니다.">
      <form className="settings-form form-stack" onSubmit={changePassword}>
        <Field label="현재 비밀번호" required><Input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} disabled={change.pending} /></Field>
        <Field label="새 비밀번호" required><Input name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} disabled={change.pending} /></Field>
        <Field label="새 비밀번호 확인" required><Input name="confirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={128} disabled={change.pending} /></Field>
        <ErrorNotice message={change.error} /><div className="form-actions"><SubmitButton pending={change.pending}>비밀번호 변경하기</SubmitButton></div>
      </form>
    </Panel>
    <Panel title="계정 탈퇴" description="거래 원본과 감사 이력을 포함한 이 계정의 모든 데이터가 영구 삭제됩니다.">
      <div className="p-6 form-stack"><p>탈퇴 전에 일반 설정에서 전체 기록을 내보내세요. 사용자 JSON 내보내기는 DB 자동 복원 파일이 아닙니다.</p>
        <Button variant="destructive" onClick={() => setDeleting(true)}>계정 탈퇴 진행</Button></div>
    </Panel>
    {deleting && <Dialog title="계정을 영구 삭제할까요?" onClose={() => { if (!remove.pending) setDeleting(false); }}>
      <form className="form-stack" onSubmit={deleteUser}>
        <p className="break-words">이 작업은 되돌릴 수 없습니다. {data.user.email} 계정의 계좌, 거래, 원본, 수정 이력과 세션을 모두 삭제합니다. 운영 백업은 별도의 보존 정책에 따라 만료됩니다.</p>
        <Field label="탈퇴 확인 이메일" required><Input name="email" type="email" autoComplete="off" required disabled={remove.pending} /></Field>
        <Field label="현재 비밀번호" required><Input name="password" type="password" autoComplete="current-password" required minLength={12} maxLength={128} disabled={remove.pending} /></Field>
        <label className="text-sm"><input name="confirm" type="checkbox" required disabled={remove.pending} /> 필요한 데이터를 내보냈으며 영구 삭제에 동의합니다.</label>
        <ErrorNotice message={remove.error} /><div className="form-actions"><Button variant="outline" disabled={remove.pending} onClick={() => setDeleting(false)}>취소</Button>
          <Button variant="destructive" type="submit" disabled={remove.pending}>{remove.pending ? "삭제 중…" : "내 계정 영구 삭제"}</Button></div>
      </form>
    </Dialog>}
  </div>;
}
