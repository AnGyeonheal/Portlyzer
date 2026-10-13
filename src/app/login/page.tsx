import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { LoginForm } from "@/components/auth/login-form";
import { runtimeConfig } from "@/lib/environment";

export const metadata: Metadata = { title: "로그인" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ verified?: string; error?: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) redirect("/");
  const config = runtimeConfig();
  const params = await searchParams;
  return <LoginForm demoEnabled={config.demoEnabled} recoveryEnabled={config.mailEnabled}
    requireEmailVerification={config.requireEmailVerification} verified={params.verified === "1"}
    verificationError={!!params.error} />;
}
