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
  if (!["super_admin", "owner", "admin", "hrd"].includes(actor.role.toLowerCase())) return null;

  // An unscoped owner/admin may not implicitly assume access to all tenants.
  if (actor.role.toLowerCase() === "super_admin") return companyId;
  return actor.companyId === companyId ? companyId : null;
}

/** Every employee/doc query must use BOTH of these predicates. */
export function validateHrdEmployeeScope(
  authorizedCompanyId: number | null,
  employeeCompanyId: number | null,
): boolean {
  return authorizedCompanyId !== null && employeeCompanyId === authorizedCompanyId;
}
