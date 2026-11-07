export type PayrollActor = { role: string; companyId: number | null };

/** Payroll financial data never supports companyId=all or implicit fallback. */
export function authorizePayrollCompany(actor: PayrollActor | null, rawCompanyId: unknown): number | null {
  if (!actor) return null;
  const role = actor.role.toLowerCase();
  if (!["admin", "owner", "super_admin", "finance", "accounting"].includes(role)) return null;
  if (typeof rawCompanyId !== "string" || !/^[1-9][0-9]*$/.test(rawCompanyId)) return null;
  const companyId = Number(rawCompanyId);
  if (!Number.isSafeInteger(companyId)) return null;
  if (!["owner", "super_admin"].includes(role) && !(role === "admin" && actor.companyId === null) && actor.companyId !== companyId) return null;
  return companyId;
}
