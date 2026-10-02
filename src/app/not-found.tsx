import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Brand } from "@/components/portfolio/shared";

export default function NotFoundPage() {
  return <main className="status-page"><Brand /><span className="not-found-number">404</span><h1>페이지를 찾을 수 없어요</h1><p>주소를 확인하거나 내 포트폴리오로 돌아가 주세요.</p><Button asChild><Link href="/">포트폴리오로 돌아가기</Link></Button></main>;
}
