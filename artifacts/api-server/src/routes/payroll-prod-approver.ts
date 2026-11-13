/**
 * Narrow PROD Payroll approval equivalence for the verified CST Owner.
 * Authentication and company scope are established by the existing Payroll
 * middleware from the canonical production session, not by client-supplied data.
 * No other Owner becomes a Super Admin and existing super_admin roles are retained.
 */
export type PayrollProdActor = {
  role?: string | null;
  email?: string | null;
  companyId?: number | null;
};

export function isPayrollProdApprover(
  actor: PayrollProdActor | null | undefined,
  scopedCompanyId: number | null | undefined,
): boolean {
  const role = String(actor?.role ?? "").trim().toLowerCase();
  if (role === "super_admin") return true;
  return role === "owner" &&
    scopedCompanyId === 1 &&
    actor?.companyId === 1 &&
    String(actor?.email ?? "").trim().toLowerCase() === "admcst001@gmail.com";
}
