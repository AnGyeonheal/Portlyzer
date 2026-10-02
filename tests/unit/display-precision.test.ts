import { describe, expect, it } from "vitest";
import { money, quantity, sum, unitMoney } from "@/components/portfolio/format";

describe("lossless financial display boundaries", () => {
  it("does not route large money strings through unsafe binary integers", () => {
    expect(money("9007199254740993.12", "USD").replace(/[^\d.-]/g, "")).toBe("9007199254740993.12");
    expect(money("-0.25", "USD").replace(/[^\d.-]/g, "")).toBe("-0.25");
    expect(unitMoney("9007199254740993.123456789012", "USD").replace(/[^\d.-]/g, "")).toBe("9007199254740993.123456789012");
  });

  it("shows supported tiny quantities and large integer quantities without changing their values", () => {
    expect(quantity("0.000000000001")).toBe("0.000000000001");
    expect(quantity("99999999999999999").replaceAll(",", "")).toBe("99999999999999999");
    expect(quantity(null)).toBe("\u2014");
    expect(quantity("0.000000000000000000000001")).toBe("1e-24");
  });

  it("keeps display aggregations exact when nearly equal large values cancel", () => {
    expect(sum(["99999999999999999.999999999999", "-99999999999999999.999999999998"])).toBe("1e-12");
    expect(sum(["1", null])).toBeNull();
  });
});
