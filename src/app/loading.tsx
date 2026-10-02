import { Brand } from "@/components/portfolio/shared";
import { Loading } from "@/components/ui/feedback";

export default function LoadingPage() {
  return <main className="status-page"><Brand /><Loading label="안전하게 포트폴리오를 준비하고 있어요…" /></main>;
}
