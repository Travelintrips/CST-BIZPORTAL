import { describe, expect, it } from "vitest";
import { estimatedUmeQrisMdr } from "../lib/reconciliation/qrisUmeMdr";

const estimate = (gross: number, paidDate = "2026-10-29", providerCode = "mandiri_direct") =>
  estimatedUmeQrisMdr({ gross, rate: 0.007, paidDate, providerCode });

describe("Mandiri UME QRIS live MDR diagnostic boundaries", () => {
  it("exempts each payment at or below Rp100,000", () => {
    expect(estimate(99999)).toBe(0);
    expect(estimate(100000)).toBe(0);
    expect(estimate(100001)).toBeCloseTo(700.007);
  });
  it("applies rate to each large payment individually", () => {
    expect(estimate(200000)).toBeCloseTo(1400);
    expect(estimate(700000)).toBeCloseTo(4900);
    expect(estimate(1600000)).toBeCloseTo(11200);
  });
  it("does not exempt earlier payments or different providers", () => {
    expect(estimate(100000, "2026-09-30")).toBeCloseTo(700);
    expect(estimate(100000, "2026-10-29", "other_provider")).toBeCloseTo(700);
  });
  it("uses per-payment gross in a mixed batch", () => {
    expect(estimate(50000) + estimate(200000)).toBeCloseTo(1400);
    expect(estimate(50000) + estimate(50000)).toBe(0);
  });
});
