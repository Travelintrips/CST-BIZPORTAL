/**
 * Employee resignation is an HRD workflow, not a separate subsystem.
 * Reuse the already-enabled, authenticated and tenant-scoped HRD PROD gate.
 * An explicit "false" remains an immediate operator kill-switch.
 * All writes still require active Owner/Super Admin session, CSRF/origin,
 * confirm + reason and row-scoped audited database mutation.
 */
export function hrdEmployeeStatusChangeEnabled(): boolean {
  return process.env.APP_ENV?.trim().toLowerCase() === "production" &&
    process.env.HRD_PROD_ENABLED === "true" &&
    process.env.HRD_EMPLOYEE_STATUS_WRITE_ENABLED?.trim().toLowerCase() !== "false";
}
