import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { runtimeConfig } from "@/lib/environment";

export const metadata: Metadata = { title: "비밀번호 재설정", robots: { index: false, follow: false } };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const params = await searchParams;
  return <ResetPasswordForm token={params.error ? "" : params.token ?? ""} enabled={runtimeConfig().mailEnabled} />;
}
