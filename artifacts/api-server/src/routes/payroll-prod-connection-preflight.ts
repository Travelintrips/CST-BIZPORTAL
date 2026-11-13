import type { IRouter, Request, Response } from "express";
import { payrollProdDedicatedRequired, payrollScopedQuery } from "./payroll-prod-db";

type ScopedPayrollRequest = Request & {
  payrollCompanyId?: number;
  payrollActor?: { role: string };
};

/**
 * Read-only proof of the actual dedicated Payroll PROD connection.
 * Existing Payroll authorization middleware runs before this route.
 * No feature flags are changed; no secret, employee, or monetary data returned.
 */
export function registerPayrollProdConnectionPreflightRoutes(router: IRouter): void {
  router.get("/payroll/connection-preflight", async (req: ScopedPayrollRequest, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    if (process.env.APP_ENV?.trim().toLowerCase() !== "production") {
      res.status(404).json({ message: "Pemeriksaan ini hanya tersedia di PROD." });
      return;
    }
    if (req.payrollActor?.role?.toLowerCase() !== "super_admin") {
      res.status(403).json({ message: "Pemeriksaan koneksi Payroll hanya untuk Super Admin." });
      return;
    }
    const companyId = req.payrollCompanyId;
    if (!Number.isSafeInteger(companyId) || !companyId || companyId <= 0) {
      res.status(403).json({ message: "Perusahaan Payroll tidak valid." });
      return;
    }

    let configured: boolean;
    try {
      configured = payrollProdDedicatedRequired();
    } catch {
      res.status(503).json({
        ready: false, readOnly: true, dedicatedConnectionVerified: false,
        code: "PAYROLL_PROD_DEDICATED_CONFIG_INVALID",
      });
      return;
    }
    if (!configured) {
      res.status(503).json({
        ready: false, readOnly: true, dedicatedConnectionVerified: false,
        code: "PAYROLL_PROD_DEDICATED_NOT_CONFIGURED",
      });
      return;
    }

    try {
      // payrollScopedQuery always uses BEGIN READ ONLY + SET LOCAL ROLE
      // + transaction-local company scope, followed by COMMIT/ROLLBACK.
      // COUNT probes verify SELECT capability without returning employee data.
      const result = await payrollScopedQuery(companyId, [
        'SELECT current_user AS "dbRole",',
        'current_setting(\'app.payroll_company_id\', true) AS "companyScope",',
        '(SELECT COUNT(*) FROM public.payroll_runs) AS "visibleRuns",',
        '(SELECT COUNT(*) FROM public.payroll_salary_profiles) AS "visibleProfiles"',
      ].join(" "), []);
      const record = result.rows[0];
      const verified = result.rowCount === 1 &&
        record?.dbRole === "bizportal_payroll_prod" &&
        record?.companyScope === String(companyId);
      if (!verified) {
        res.status(503).json({
          ready: false, readOnly: true, dedicatedConnectionVerified: false,
          code: "PAYROLL_PROD_ROLE_OR_SCOPE_INVALID",
        });
        return;
      }
      res.status(200).json({
        ready: true,
        readOnly: true,
        dedicatedConnectionVerified: true,
        companyScopeVerified: true,
        roleVerified: true,
        canPay: false,
        canPostJournal: false,
      });
    } catch {
      // Deliberately do not serialize DB errors, URLs, credentials, or query text.
      res.status(503).json({
        ready: false, readOnly: true, dedicatedConnectionVerified: false,
        code: "PAYROLL_PROD_DATABASE_READINESS_FAILED",
      });
    }
  });
}
