import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { PortfolioApp } from "@/components/portfolio/portfolio-app";

export default async function HomePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  const profile = await db.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, baseCurrency: true, isDemo: true },
  });
  if (!profile) redirect("/login");
  return <PortfolioApp initialUser={profile} />;
}
