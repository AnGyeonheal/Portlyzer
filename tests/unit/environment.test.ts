import { describe, expect, it } from "vitest";
import { runtimeConfig } from "@/lib/environment";

const local = {
  DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:5432/fixture?schema=public",
  BETTER_AUTH_URL: "http://127.0.0.1:3000",
  BETTER_AUTH_SECRET: "fixture-only-auth-secret-not-a-production-key",
};
const publicConfig = {
  ...local, APP_MODE: "public", BETTER_AUTH_URL: "https://portfolio.example.invalid",
  DATABASE_URL: "postgresql://fixture:fixture@db.example.invalid:5432/fixture?schema=public&sslmode=verify-full",
  MAIL_ENABLED: "true", AUTH_REQUIRE_EMAIL_VERIFICATION: "true",
  MAIL_FROM: "no-reply@example.invalid", SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587",
  SMTP_USER: "fixture", SMTP_PASSWORD: "fixture-only",
};

describe("runtime readiness gates", () => {
  it("allows private local operation without claiming email support", () => {
    expect(runtimeConfig(local)).toMatchObject({ mode: "local", demoEnabled: false, mailEnabled: false });
  });
  it("requires explicit public mode rather than silently accepting an external origin", () => {
    expect(() => runtimeConfig({ ...local, BETTER_AUTH_URL: "https://portfolio.example.invalid" })).toThrow("loopback");
  });
  it("accepts verified-email public configuration with mandatory SMTP STARTTLS", () => {
    expect(runtimeConfig(publicConfig)).toMatchObject({ mode: "public", requireEmailVerification: true, smtp: { requireTLS: true } });
  });
  it.each([
    { BETTER_AUTH_URL: "http://portfolio.example.invalid" },
    { DATABASE_URL: local.DATABASE_URL },
    { MAIL_ENABLED: "false" },
    { AUTH_REQUIRE_EMAIL_VERIFICATION: "false" },
    { ENABLE_DEMO: "true" },
    { SMTP_PASSWORD: "" },
    { SMTP_PORT: "70000" },
    { SMTP_HOST: "localhost" },
    { MAIL_FROM: "not-an-email" },
    { ENABLE_DEMO: "yes" },
  ])("refuses incomplete public configuration: %j", (patch) => {
    expect(() => runtimeConfig({ ...publicConfig, ...patch })).toThrow();
  });
  it("reports invalid fields without exposing credentials", () => {
    const secret = "replace-with-sensitive-test-value-do-not-print";
    try {
      runtimeConfig({ ...local, BETTER_AUTH_SECRET: secret, SMTP_PASSWORD: "also-secret" });
      expect.unreachable("invalid configuration must fail");
    } catch (error) {
      expect(String(error)).toContain("BETTER_AUTH_SECRET");
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("also-secret");
    }
  });
});
