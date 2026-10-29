import { describe, expect, it } from "vitest";
import { mandiriQrisChargeableGross } from "../lib/reconciliation/qrisMdrPolicy.js";

const payment = (amount: number, paymentDate = "2026-10-29") =>
  ({ amount, paymentDate });

describe("Mandiri QRIS universally exempt MDR base", () => {
  it.each([
    [99999, 0],
    [100000, 0],
    [100001, 100001],
    [200000, 200000],
    [500000, 500000],
  ])("amount %i has chargeable base %i", (amount, expected) => {
    expect(mandiriQrisChargeableGross([payment(amount)])).toBe(expected);
  });

  it("applies Rp100k threshold per transaction not per batch", () => {
    expect(mandiriQrisChargeableGross([payment(50000), payment(200000)]))
      .toBe(200000);
    expect(mandiriQrisChargeableGross([payment(50000), payment(50000)]))
      .toBe(0);
  });

  it("does not retroactively exempt pre-October payments", () => {
    expect(mandiriQrisChargeableGross([payment(100000, "2026-09-30")]))
      .toBe(100000);
  });

  it("fails closed on invalid amount or local date", () => {
    expect(() => mandiriQrisChargeableGross([payment(-1)])).toThrow();
    expect(() => mandiriQrisChargeableGross([{ amount: 1, paymentDate: "" }])).toThrow();
  });
});
