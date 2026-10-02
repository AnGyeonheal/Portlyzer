"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Brand } from "@/components/portfolio/shared";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="status-page"><Brand /><AlertTriangle size={40} className="text-amber-600" /><h1>화면을 불러오지 못했어요</h1><p>잠시 후 다시 시도해 주세요. 저장한 거래 기록은 유지됩니다.</p><div className="button-row"><Button onClick={reset}>다시 시도</Button><Button asChild variant="outline"><Link href="/login">로그인 화면</Link></Button></div></main>;
}
