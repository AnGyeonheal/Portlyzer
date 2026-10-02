import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { WorkspaceData } from "../../src/lib/contracts";

const directory = join(process.cwd(), ".e2e-state");
const authFile = join(directory, "auth.json");
const expectedFile = join(directory, "expectation.json");

test("session and financial records survive a separate server process", async ({ browser, baseURL }) => {
  test.skip(process.env.RUN_RESTART_PROBE !== "1", "Run after stopping/restarting the application server.");
  expect(existsSync(authFile)).toBe(true);
  expect(existsSync(expectedFile)).toBe(true);
  const expected = z.object({
    userId: z.string(), accountId: z.string(), buyId: z.string(),
    query: z.string(), totalValue: z.string(), transactionCount: z.number(),
  }).parse(JSON.parse(readFileSync(expectedFile, "utf8")));
  const context = await browser.newContext({ storageState: authFile, baseURL });
  try {
    const response = await context.request.get(`/api/workspace?${expected.query}`);
    expect(response.status()).toBe(200);
    const data: WorkspaceData = await response.json();
    expect(data.user.id).toBe(expected.userId);
    expect(data.accounts.some((account) => account.id === expected.accountId)).toBe(true);
    expect(data.analysis.summary.totalValue).toBe(expected.totalValue);
    expect(data.transactions).toHaveLength(expected.transactionCount);
    expect(data.transactions.find((transaction) => transaction.id === expected.buyId)?.price).toBe("181");
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
    unlinkSync(authFile);
    unlinkSync(expectedFile);
  } finally {
    await context.close();
  }
});
