import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
if (process.env.RUN_INTEGRATION !== "1") throw new Error("E2E writes fixture data. Set RUN_INTEGRATION=1 and an isolated DATABASE_URL explicitly.");
const mailTests = process.env.RUN_MAIL_E2E === "1";
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100";
const port = new URL(baseURL).port || "3100";
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
process.env.no_proxy = process.env.NO_PROXY;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: mailTests ? "**/auth.spec.ts" : ["**/portfolio.spec.ts", "**/import-template.spec.ts", "**/restart.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run start -- --port ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      BETTER_AUTH_URL: baseURL, NEXT_TELEMETRY_DISABLED: "1", APP_MODE: "local",
      ENABLE_DEMO: mailTests ? "false" : "true",
      MAIL_ENABLED: mailTests ? "true" : "false", AUTH_REQUIRE_EMAIL_VERIFICATION: mailTests ? "true" : "false",
      SMTP_HOST: "127.0.0.1", SMTP_PORT: process.env.E2E_SMTP_PORT ?? "3125", SMTP_SECURE: "false",
      SMTP_USER: "", SMTP_PASSWORD: "", MAIL_FROM: "no-reply@example.invalid",
    },
  },
});
