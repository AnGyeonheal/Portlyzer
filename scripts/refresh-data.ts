import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { AppError } from "../src/lib/errors";

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const { db } = await import("../src/lib/db");
  try {
    let values: Record<string, string | undefined>;
    try {
      values = parseArgs({
        options: {
          "user-id": { type: "string" },
          provider: { type: "string" },
          from: { type: "string" },
          to: { type: "string" },
          "asset-id": { type: "string" },
        },
        strict: true,
        allowPositionals: false,
      }).values;
    } catch {
      throw new AppError(422, "CLI_ARGUMENTS", "Use --user-id, --provider, --from, --to and optionally --asset-id.");
    }
    const userId = values["user-id"] ?? process.env.REFRESH_USER_ID;
    if (!userId?.trim()) {
      throw new AppError(422, "CLI_USER_REQUIRED", "An explicit --user-id or REFRESH_USER_ID is required; bulk refresh is never implied.");
    }
    const { refreshMarketData } = await import("../src/lib/services/market");
    const job = await refreshMarketData(userId, {
      provider: values.provider ?? process.env.REFRESH_PROVIDER ?? "FRANKFURTER",
      from: values.from ?? process.env.REFRESH_FROM,
      to: values.to ?? process.env.REFRESH_TO,
      ...((values["asset-id"] ?? process.env.REFRESH_ASSET_ID)
        ? { assetId: values["asset-id"] ?? process.env.REFRESH_ASSET_ID } : {}),
    });
    console.log(JSON.stringify(job));
    if (job.status === "RUNNING") process.exitCode = 2;
  } catch (error) {
    const details = error instanceof AppError && typeof error.details === "object" && error.details !== null
      ? error.details as { jobId?: string } : undefined;
    console.error(JSON.stringify({
      status: "FAILED",
      code: error instanceof AppError ? error.code : error instanceof ZodError ? "VALIDATION" : "REFRESH_FAILED",
      message: error instanceof AppError ? error.message :
        error instanceof ZodError ? "Check provider, dates and asset selection." : "Refresh failed; check database connectivity and provider configuration.",
      ...(details?.jobId ? { jobId: details.jobId } : {}),
    }));
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

void main().catch(() => {
  console.error(JSON.stringify({ status: "FAILED", code: "CLI_INITIALIZATION_FAILED", message: "Refresh initialization failed." }));
  process.exitCode = 1;
});
