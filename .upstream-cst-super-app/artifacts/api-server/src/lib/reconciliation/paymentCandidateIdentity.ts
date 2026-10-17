/** Reject placeholder or malformed payment candidate IDs before persisting matches. */
export function isInvalidPaymentCandidateIdentity(candidate: { type: string; id: unknown }): boolean {
  if (candidate.type !== "payment" && candidate.type !== "sport_payment") return false;
  return typeof candidate.id !== "number" || !Number.isSafeInteger(candidate.id) || candidate.id <= 0;
}
