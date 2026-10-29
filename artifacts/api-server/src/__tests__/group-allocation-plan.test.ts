import { describe, expect, it } from "vitest";
import { allocationKey, planGroupAllocations } from "../lib/payments/groupAllocationPlan";

const ref = "CART-MV9GNR8B-ASRX";
const receipt = { id: 814, groupRef: ref, amountCents: 160000000, method: "Transfer Bank", postedDebitCents: 160000000, isPosted: true };
const bookings = Array.from({ length: 8 }, (_, i) => ({ id: 1496 + i, groupRef: ref, totalCents: 20000000, existingAllocatedCents: 0 }));

describe("DSV group allocation planning (read only)", () => {
  it("allocates one verified receipt across eight group bookings", () => {
    const p = planGroupAllocations(receipt, bookings);
    expect(p.allocations).toHaveLength(8);
    expect(p.totalCents).toBe(160000000);
    expect(new Set(p.allocations.map(allocationKey)).size).toBe(8);
    expect(p.allocations.every(a => a.amountCents === 20000000 && a.receiptId === 814)).toBe(true);
  });
  it("is deterministic on retry without mutating input", () => {
    const before = JSON.stringify(bookings);
    expect(planGroupAllocations(receipt, bookings)).toEqual(planGroupAllocations(receipt, bookings));
    expect(JSON.stringify(bookings)).toBe(before);
  });
  it("rejects recorded allocations and duplicate booking IDs", () => {
    expect(() => planGroupAllocations(receipt, [{ ...bookings[0]!, existingAllocatedCents: 1 }, ...bookings.slice(1)])).toThrow("EXISTING_ALLOCATION_REQUIRES_REVIEW");
    expect(() => planGroupAllocations(receipt, [...bookings.slice(0, 7), bookings[0]!])).toThrow("INVALID_GROUP_BOOKING");
  });
  it("rejects wrong group, amount, method, and missing journal evidence", () => {
    expect(() => planGroupAllocations(receipt, [{ ...bookings[0]!, groupRef: "OTHER" }, ...bookings.slice(1)])).toThrow("INVALID_GROUP_BOOKING");
    expect(() => planGroupAllocations(receipt, bookings.slice(1))).toThrow("RECEIPT_GROUP_TOTAL_MISMATCH");
    expect(() => planGroupAllocations({ ...receipt, method: "QRIS" }, bookings)).toThrow("TRANSFER_METHOD_REQUIRES_VERIFICATION");
    expect(() => planGroupAllocations({ ...receipt, postedDebitCents: 20000000 }, bookings)).toThrow("SOURCE_RECEIPT_NOT_ACCOUNTED");
  });
});
