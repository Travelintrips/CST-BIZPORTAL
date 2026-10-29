/**
 * Read-only allocation planner: one receipt, multiple booking allocations.
 * No journal/payment inserts are performed here. A posted receipt is never
 * duplicated when a future settlement workflow consumes this plan.
 */
export type GroupBooking = {
  id: number;
  groupRef: string;
  totalCents: number;
  existingAllocatedCents: number;
};
export type GroupReceipt = {
  id: number;
  groupRef: string;
  amountCents: number;
  method: string;
  postedDebitCents: number;
  isPosted: boolean;
};
export type Allocation = { receiptId: number; bookingId: number; amountCents: number };

export function planGroupAllocations(
  receipt: GroupReceipt,
  bookings: readonly GroupBooking[],
): { receiptId: number; groupRef: string; allocations: Allocation[]; totalCents: number } {
  if (!receipt.groupRef || !Number.isSafeInteger(receipt.amountCents) || receipt.amountCents <= 0)
    throw new Error("INVALID_GROUP_RECEIPT");
  if (!receipt.isPosted || receipt.postedDebitCents !== receipt.amountCents)
    throw new Error("SOURCE_RECEIPT_NOT_ACCOUNTED");
  if (receipt.method.toLowerCase() !== "transfer bank")
    throw new Error("TRANSFER_METHOD_REQUIRES_VERIFICATION");
  if (bookings.length === 0) throw new Error("GROUP_HAS_NO_BOOKINGS");
  const ids = new Set<number>();
  let totalCents = 0;
  const allocations: Allocation[] = [];
  for (const b of bookings) {
    if (!Number.isSafeInteger(b.id) || b.id <= 0 || ids.has(b.id)
      || b.groupRef !== receipt.groupRef || !Number.isSafeInteger(b.totalCents)
      || b.totalCents <= 0 || !Number.isSafeInteger(b.existingAllocatedCents)
      || b.existingAllocatedCents < 0 || b.existingAllocatedCents > b.totalCents)
      throw new Error("INVALID_GROUP_BOOKING");
    ids.add(b.id);
    // Fail closed: an existing allocation must be reconciled, not silently repeated.
    if (b.existingAllocatedCents !== 0) throw new Error("EXISTING_ALLOCATION_REQUIRES_REVIEW");
    totalCents += b.totalCents;
    allocations.push({ receiptId: receipt.id, bookingId: b.id, amountCents: b.totalCents });
  }
  if (totalCents !== receipt.amountCents) throw new Error("RECEIPT_GROUP_TOTAL_MISMATCH");
  return { receiptId: receipt.id, groupRef: receipt.groupRef, allocations, totalCents };
}

/** Stable natural keys for an idempotent, uniquely constrained allocation ledger. */
export function allocationKey(allocation: Allocation): string {
  return `${allocation.receiptId}:${allocation.bookingId}`;
}
