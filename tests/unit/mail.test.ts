import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ sendMail: vi.fn(), close: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => transport } }));
import { requireMailDelivery, sendAccountEmail } from "@/lib/mail";

beforeEach(() => {
  vi.stubEnv("APP_MODE", "local");
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@127.0.0.1:5432/fixture");
  vi.stubEnv("BETTER_AUTH_URL", "http://127.0.0.1:3000");
  vi.stubEnv("BETTER_AUTH_SECRET", "fixture-only-mail-secret-not-a-production-key");
  vi.stubEnv("MAIL_ENABLED", "true");
  vi.stubEnv("SMTP_HOST", "127.0.0.1");
  vi.stubEnv("SMTP_PORT", "3125");
  vi.stubEnv("SMTP_USER", "");
  vi.stubEnv("SMTP_PASSWORD", "");
  vi.stubEnv("MAIL_FROM", "no-reply@example.invalid");
  transport.sendMail.mockResolvedValue({ accepted: ["fixture@example.invalid"], rejected: [] });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("account mail delivery", () => {
  it("turns a swallowed transport error into an explicit request failure without leaking tokens", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    transport.sendMail.mockRejectedValueOnce(new Error("SMTP details containing sensitive data"));
    const link = "http://127.0.0.1:3000/reset-password?token=private-fixture-token";
    await expect(requireMailDelivery(async () => {
      try { await sendAccountEmail("reset", "fixture@example.invalid", link); } catch { /* Simulate the library's absorbed rejection. */ }
      return "library-success";
    })).rejects.toMatchObject({ status: 503, code: "MAIL_DELIVERY_FAILED" });
    const log = logger.mock.calls.map((call) => String(call[0])).join("\n");
    expect(log).toContain("mail_delivery_failed");
    expect(log).not.toContain("fixture@example.invalid");
    expect(log).not.toContain("private-fixture-token");
    expect(log).not.toContain("sensitive data");
    expect(transport.close).toHaveBeenCalled();
  });
  it("isolates concurrent requests instead of sharing a global error flag", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    transport.sendMail.mockRejectedValueOnce(new Error("fixture failure"));
    const request = () => requireMailDelivery(async () => {
      try { await sendAccountEmail("reset", "fixture@example.invalid", "http://127.0.0.1:3000/reset-password?token=fixture"); } catch { /* Simulate Better Auth. */ }
      return "accepted";
    });
    const results = await Promise.allSettled([request(), request()]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
  });
  it("refuses disabled mail and foreign link origins without contacting SMTP", async () => {
    await expect(sendAccountEmail("reset", "fixture@example.invalid", "https://untrusted.invalid/reset")).rejects.toMatchObject({ code: "MAIL_LINK_ORIGIN" });
    vi.stubEnv("MAIL_ENABLED", "false");
    await expect(sendAccountEmail("reset", "fixture@example.invalid", "http://127.0.0.1:3000/reset")).rejects.toMatchObject({ code: "MAIL_DISABLED" });
    expect(transport.sendMail).not.toHaveBeenCalled();
  });
});
