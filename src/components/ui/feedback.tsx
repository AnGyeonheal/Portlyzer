"use client";

import { AlertCircle, CheckCircle2, Inbox, LoaderCircle, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";

export function ErrorNotice({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return <div className="notice notice-error" role="alert"><AlertCircle size={18} /><span>{message}</span></div>;
}

export function Loading({ label = "데이터를 불러오는 중입니다…" }: { label?: string }) {
  return <div className="loading-state" role="status"><LoaderCircle className="animate-spin" size={24} /><span>{label}</span></div>;
}

export function EmptyState({ title = "아직 기록이 없어요", description, action }: {
  title?: string; description: string; action?: ReactNode;
}) {
  return <div className="empty-state"><span className="empty-icon"><Inbox size={25} /></span><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return <div className="toast" role="status"><CheckCircle2 size={19} /><span>{message}</span><Button variant="ghost" size="icon" aria-label="알림 닫기" onClick={onClose}><X /></Button></div>;
}

export function SubmitButton({ pending, children = "저장하기", disabled }: { pending: boolean; children?: ReactNode; disabled?: boolean }) {
  return <Button type="submit" disabled={pending || disabled}>{pending && <LoaderCircle className="animate-spin" />}{pending ? "처리 중…" : children}</Button>;
}
