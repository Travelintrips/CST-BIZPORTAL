/** Reject placeholder or malformed payment candidate IDs before persisting matches. */
export function isInvalidPaymentCandidateIdentity(candidate: { type: string; id: unknown }): boolean {
  if (candidate.type !== "payment" && candidate.type !== "sport_payment") return false;
  return typeof candidate.id !== "number" || !Number.isSafeInteger(candidate.id) || candidate.id <= 0;
}

/** Defense in depth: block payment candidates outside the mutation company scope. */
export function isPaymentCandidateOutsideCompanyScope(
  candidate: { type: string; company_id: unknown },
  mutationCompanyId: unknown,
): boolean {
  if (candidate.type !== "payment" && candidate.type !== "sport_payment") return false;
  const candidateCompany = candidate.company_id;
  return typeof mutationCompanyId !== "number" || !Number.isSafeInteger(mutationCompanyId)
    || mutationCompanyId <= 0 || typeof candidateCompany !== "number"
    || !Number.isSafeInteger(candidateCompany) || candidateCompany !== mutationCompanyId;
}
