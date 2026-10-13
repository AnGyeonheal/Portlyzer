import { existsSync } from "node:fs";
import { ZodError } from "zod";
import { AppError } from "../src/lib/errors";
import { refreshOptions } from "./lib/refresh-options";

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const { db } = await import("../src/lib/db");
  try {
    const { userId, request } = refreshOptions(process.argv.slice(2));
    const { refreshMarketData } = await import("../src/lib/services/market");
    const job = await refreshMarketData(userId, request);
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
