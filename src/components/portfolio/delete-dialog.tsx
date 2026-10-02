"use client";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorNotice } from "@/components/ui/feedback";
import { request, useMutation } from "./api";
import { useWorkspace } from "./workspace-context";

export function DeleteDialog({ title, description, url, onClose }: { title: string; description: string; url: string; onClose: () => void }) {
  const { refresh, notify, filters, setFilters } = useWorkspace();
  const mutation = useMutation();
  return <Dialog title={title} onClose={onClose}><div className="form-stack"><p>{description}</p><ErrorNotice message={mutation.error} /><div className="form-actions"><Button variant="outline" disabled={mutation.pending} onClick={onClose}>취소</Button><Button variant="destructive" disabled={mutation.pending} onClick={() => mutation.run(() => request(url, { method: "DELETE" }), () => {
    if (url === `/api/accounts/${filters.accountId}`) setFilters({ ...filters, accountId: "all" });
    if (url === `/api/portfolios/${filters.portfolioId}`) setFilters({ ...filters, portfolioId: "all", accountId: "all" });
    notify("삭제되었습니다."); refresh(); onClose();
  })}>{mutation.pending ? "삭제 중…" : "삭제 확인"}</Button></div></div></Dialog>;
}
