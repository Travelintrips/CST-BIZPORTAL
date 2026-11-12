/**
 * HRD document access is independent from Payroll authorization.
 * Fail closed when the requested tenant is absent, invalid, or mismatched.
 * The caller must resolve the actor from a verified server-side session.
 */
export type HrdActor = {
  role: string;
  companyId: number | null;
};

export function authorizeHrdCompany(
  actor: HrdActor | null,
  requestedCompanyId: unknown,
): number | null {
  if (!actor) return null;
  if (typeof requestedCompanyId !== "string" || !/^[1-9][0-9]*$/.test(requestedCompanyId)) return null;

  const companyId = Number(requestedCompanyId);
  if (!Number.isSafeInteger(companyId)) return null;
  // Temporary policy: only a verified Super Admin session can access HRD.
  // The requested company remains explicit, and row-level isolation still applies.
  if (actor.role.trim().toLowerCase() !== "super_admin") return null;
  return companyId;
}

/** Every employee/doc query must use BOTH of these predicates. */
export function validateHrdEmployeeScope(
  authorizedCompanyId: number | null,
  employeeCompanyId: number | null,
): boolean {
  return authorizedCompanyId !== null && employeeCompanyId === authorizedCompanyId;
}
