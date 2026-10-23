/** Bank Indonesia QRIS MDR expansion effective 2026-10-01.
 * Rates apply to each payment, never aggregate daily gross.
 * The merchant category must be verified from the acquiring provider.
 * This is a diagnostic policy calculator, NOT authority to post journals.
 */
export type QrisMerchantCategory = "micro" | "regular" | "education" | "fuel" | "public-service";

export function calculateQrisMdr(input: {
  amount: number;
  transactionDate: string;
  merchantCategory: QrisMerchantCategory;
}): number {
  const { amount, transactionDate, merchantCategory } = input;
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("QRIS amount must be a nonnegative whole rupiah value");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate) || Number.isNaN(Date.parse(`${transactionDate}T00:00:00Z`))) {
    throw new Error("QRIS transactionDate must be YYYY-MM-DD");
  }
  const expanded = transactionDate >= "2026-10-01";
  let rate: number;
  if (merchantCategory === "public-service") rate = 0;
  else if (merchantCategory === "micro") rate = amount <= 500_000 ? 0 : 0.003;
  else if (expanded && amount <= 100_000) rate = 0;
  else if (merchantCategory === "regular") rate = 0.007;
  else if (merchantCategory === "education") rate = 0.006;
  else if (merchantCategory === "fuel") rate = 0.004;
  else throw new Error("QRIS merchant category is not verified");
  return Math.round(amount * rate);
}

export function sumQrisSettlementMdr(payments: Array<Parameters<typeof calculateQrisMdr>[0]>): number {
  return payments.reduce((sum, payment) => sum + calculateQrisMdr(payment), 0);
}

/** A candidate preview is deliberately not canonical settlement evidence.
 * Recompute from the current set on every call; a removed or edited payment
 * must never leave a stale MDR. An incomplete set has no final MDR.
 */
export function calculateQrisCandidatePreview(input: {
  payments: Array<{id: number; amount: number; transactionDate: string; merchantCategory: QrisMerchantCategory}>;
  candidatesComplete: boolean;
}) {
  const unique = new Set(input.payments.map(p => p.id));
  if (unique.size !== input.payments.length) throw new Error("Duplicate QRIS candidate payment");
  const gross = input.payments.reduce((sum,p) => sum + p.amount, 0);
  const mdr = sumQrisSettlementMdr(input.payments);
  return {
    grossAmount: gross,
    provisionalMdrAmount: mdr,
    mdrAmount: input.candidatesComplete && input.payments.length > 0 ? mdr : null,
    netAmount: input.candidatesComplete && input.payments.length > 0 ? gross - mdr : null,
    candidatesComplete: input.candidatesComplete && input.payments.length > 0,
  };
}
