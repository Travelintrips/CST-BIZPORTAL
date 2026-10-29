/**
 * A settlement batch is not a QRIS transaction. Evaluate the MDR exemption
 * using each individual gross payment amount and its Jakarta payment date.
 * Merchant category remains external configuration; this routine only
 * enforces the universally applicable <= Rp100,000 exemption.
 */
export function mandiriQrisChargeableGross(
  payments: ReadonlyArray<{ amount: number; paymentDate: string }>,
): number {
  return payments.reduce((total, payment) => {
    if (!Number.isFinite(payment.amount) || payment.amount <= 0) {
      throw new Error("INVALID_QRIS_PAYMENT_AMOUNT");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payment.paymentDate)) {
      throw new Error("INVALID_QRIS_PAYMENT_DATE");
    }
    return total + (
      payment.paymentDate >= "2026-10-01" && payment.amount <= 100000
        ? 0 : payment.amount
    );
  }, 0);
}
