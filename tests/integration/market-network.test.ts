import { describe, expect, it } from "vitest";
import { FrankfurterProvider } from "../../src/lib/providers";

describe.runIf(process.env.RUN_NETWORK_TESTS === "1")("live keyless ECB API contract", () => {
  it("retrieves the verified 2024-01-02 USD/KRW reference without an API key", async () => {
    const rows = await new FrankfurterProvider().getFx({
      from: "2024-01-02", to: "2024-01-05", base: "USD", quote: "KRW",
    }, { userId: "network-smoke-only", isDemo: false });
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      date: "2024-01-02", base: "USD", quote: "KRW", rate: "1313.23", source: "FRANKFURTER",
    });
    expect(rows.every(row => row.date >= "2024-01-02" && row.date <= "2024-01-05")).toBe(true);
    expect(rows.every(row => Number.isFinite(Date.parse(row.fetchedAt)))).toBe(true);
  }, 60_000);
});
