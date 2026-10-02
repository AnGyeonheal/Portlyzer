import { describe, expect, it } from "vitest";
import { dayInput, decimalInput, positiveInput } from "@/lib/input";

describe("server input boundaries", () => {
  it("validates actual calendar dates instead of Date rollover", () => {
    expect(dayInput.safeParse("2024-02-29").success).toBe(true);
    expect(dayInput.safeParse("2025-02-29").success).toBe(false);
    expect(dayInput.safeParse("2025-02-31").success).toBe(false);
    expect(dayInput.safeParse("03/04/2025").success).toBe(false);
  });

  it("retains decimal fractions without binary conversion", () => {
    expect(decimalInput.parse("0.123456789012")).toBe("0.123456789012");
    for (const invalid of ["NaN", "Infinity", "1e10", "-1", "1.1234567890123", "100000000000000000", "1,2"]) {
      expect(decimalInput.safeParse(invalid).success).toBe(false);
    }
    expect(positiveInput.safeParse("0").success).toBe(false);
  });
});
