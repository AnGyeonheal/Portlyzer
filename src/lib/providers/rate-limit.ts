import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../db";
import { ProviderError } from "./errors";

export type NetworkProviderId = "FRANKFURTER" | "ALPHA_VANTAGE";

export const MARKET_RATE_LIMITS = {
  FRANKFURTER: { global: 120, user: 30, windowMs: 60 * 60 * 1000 },
  ALPHA_VANTAGE: { global: 25, user: 10, windowMs: 24 * 60 * 60 * 1000 },
} as const;

export async function consumeProviderRequest(provider: NetworkProviderId, userId: string): Promise<void> {
  const limits = MARKET_RATE_LIMITS[provider];
  const now = new Date();
  const cutoff = new Date(now.getTime() - limits.windowMs);
  const keyId = provider === "ALPHA_VANTAGE"
    ? createHash("sha256").update((process.env.ALPHA_VANTAGE_API_KEY ?? "").trim()).digest("hex").slice(0, 24)
    : "ecb";
  const prefix = `market:${provider}:${keyId}`;
  const budgets = [
    { key: `${prefix}:global`, limit: limits.global },
    { key: `${prefix}:user:${userId}`, limit: limits.user },
  ];
  await db.$transaction(async tx => {
    for (const budget of budgets) {
      const changed = await tx.$queryRaw<{ count: number }[]>(Prisma.sql`
        INSERT INTO "ApiRateLimit" ("key", "count", "windowStart")
        VALUES (${budget.key}, 1, ${now})
        ON CONFLICT ("key") DO UPDATE SET
          "count" = CASE WHEN "ApiRateLimit"."windowStart" <= ${cutoff}
            THEN 1 ELSE "ApiRateLimit"."count" + 1 END,
          "windowStart" = CASE WHEN "ApiRateLimit"."windowStart" <= ${cutoff}
            THEN ${now} ELSE "ApiRateLimit"."windowStart" END
        WHERE "ApiRateLimit"."windowStart" <= ${cutoff} OR "ApiRateLimit"."count" < ${budget.limit}
        RETURNING "count"
      `);
      if (changed.length !== 1) {
        throw new ProviderError(
          "PROVIDER_QUOTA_EXCEEDED",
          "The application provider request budget is exhausted. Wait for its window to reset or use manual observations.",
          false,
          429,
        );
      }
    }
  });
}
