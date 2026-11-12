/**
 * HRD document access is independent from Payroll authorization.
 * Fail closed when the requested tenant is absent, invalid, or mismatched.
 * The caller must resolve the actor from a verified server-side session.
 */
export type HrdActor = {
  role: string;
  companyId: number | null;
  /** Verified by the HRD route after a fresh public.users lookup. */
  cstOwnerHrdApproved?: boolean;
};

export function authorizeHrdCompany(
  actor: HrdActor | null,
  requestedCompanyId: unknown,
): number | null {
  if (!actor) return null;
  if (typeof requestedCompanyId !== "string" || !/^[1-9][0-9]*$/.test(requestedCompanyId)) return null;

  const companyId = Number(requestedCompanyId);
  if (!Number.isSafeInteger(companyId)) return null;
  // Existing Super Admin access remains unchanged.
  // An explicitly verified, named CST owner may access ONLY company 1.
  // This boolean must be supplied exclusively from the server-side DB identity check.
  const role = actor.role.trim().toLowerCase();
  if (role !== "super_admin" &&
      !(role === "owner" && actor.companyId === 1 &&
        companyId === 1 && actor.cstOwnerHrdApproved === true)) return null;
  return companyId;
}

/** Every employee/doc query must use BOTH of these predicates. */
export function validateHrdEmployeeScope(
  authorizedCompanyId: number | null,
  employeeCompanyId: number | null,
): boolean {
  return authorizedCompanyId !== null && employeeCompanyId === authorizedCompanyId;
}
