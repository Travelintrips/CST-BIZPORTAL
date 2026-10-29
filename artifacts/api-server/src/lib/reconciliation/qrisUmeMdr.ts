/**
 * Estimate MDR for the read-only QRIS review UI, never rewrite recorded MDR.
 * Applies Mandiri UME cutoff per payment (not aggregate settlement gross).
 */
export function estimatedUmeQrisMdr(input: {
  gross: number; rate: number; paidDate: string | null; providerCode: string | null;
}): number {
  const { gross, rate, paidDate, providerCode } = input;
  if (providerCode === "mandiri_direct"
      && paidDate != null && paidDate >= "2026-10-01"
      && gross > 0 && gross <= 100000) return 0;
  return gross * rate;
}
