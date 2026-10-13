import { describe, expect, it } from "vitest";
import { refreshOptions } from "../../scripts/lib/refresh-options";

describe("scheduled refresh selection", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  it("computes a bounded inclusive UTC window for a named user", () => {
    expect(refreshOptions(["--user-id", "fixture", "--days", "7"], {}, now)).toEqual({
      userId: "fixture", request: { provider: "FRANKFURTER", from: "2026-09-27", to: "2026-10-03" },
    });
  });
  it("supports explicit environment-based scheduling", () => {
    expect(refreshOptions([], { REFRESH_USER_ID: "fixture", REFRESH_DAYS: "1" }, now).request).toMatchObject({
      from: "2026-10-03", to: "2026-10-03",
    });
  });
  it.each(["0", "-1", "366", "1.5", "nan"])("rejects invalid lookback %s", (days) => {
    expect(() => refreshOptions(["--user-id", "fixture", "--days", days], {}, now)).toThrow();
  });
  it("never implies a bulk refresh or overrides a conflicting fixed period", () => {
    expect(() => refreshOptions(["--days", "7"], {}, now)).toThrow("explicit");
    expect(() => refreshOptions(["--user-id", "fixture", "--days", "7", "--from", "2025-01-01"], {}, now)).toThrow("either");
    expect(() => refreshOptions(["--user-id", "fixture"], {}, now)).toThrow("Set --from");
  });
});
