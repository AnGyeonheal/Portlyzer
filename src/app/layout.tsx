import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Portlyzer · 나의 투자를 한눈에", template: "%s · Portlyzer" },
  description: "흩어진 투자 기록을 모아 포트폴리오, 수익률, 배당과 목표를 한눈에 관리하세요.",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko" data-scroll-behavior="smooth"><body>{children}</body></html>;
}
