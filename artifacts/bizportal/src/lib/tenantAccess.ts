const TENANT_DASHBOARD_ROLES = new Set([
  "admin",
  "owner",
  "super_admin",
  "manager",
]);

export const TENANT_DASHBOARD_COMPANY_IDS = [1, 4] as const;

export function canAccessTenantDashboard(
  role: unknown,
  companyId: number | null | undefined,
  isConsolidated = false,
): boolean {
  const normalizedRole = typeof role === "string" ? role.trim().toLowerCase() : "";
  return !isConsolidated
    && companyId != null
    && TENANT_DASHBOARD_COMPANY_IDS.includes(companyId as (typeof TENANT_DASHBOARD_COMPANY_IDS)[number])
    && TENANT_DASHBOARD_ROLES.has(normalizedRole);
}