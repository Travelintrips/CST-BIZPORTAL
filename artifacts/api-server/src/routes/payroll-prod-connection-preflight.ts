import type { IRouter, Request, Response } from "express";
import { pool } from "@workspace/db";
import { payrollReadOnlyReady, payrollProdSharedReadOnlyEnabled, payrollScopedQuery } from "./payroll-prod-db";
import { payrollReadinessSafeReason } from "./payroll-prod-readiness-error";

type ScopedPayrollRequest = Request & {
  payrollCompanyId?: number;
  payrollActor?: { id: string; email: string; role: string; companyId: number | null };
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
    const companyId = req.payrollCompanyId;
    if (!Number.isSafeInteger(companyId) || !companyId || companyId <= 0) {
      res.status(403).json({ message: "Perusahaan Payroll tidak valid." });
      return;
    }
    const actor = req.payrollActor;
    const isSuperAdmin = actor?.role.trim().toLowerCase() === "super_admin";
    // CST's already-designated owner may inspect connection readiness only.
    // Resolve the signed account through its email; Supabase session.id may differ
    // from public.users.id. The database row ID itself remains strictly pinned.
    // This is NOT a general Owner privilege and does not alter any write/approval routes.
    const designatedOwner =
      companyId === 1 &&
      actor?.email.trim().toLowerCase() === "admcst001@gmail.com" &&
      actor.role.trim().toLowerCase() === "owner" &&
      actor.companyId === 1;
    let ownerVerified = false;
    if (!isSuperAdmin && designatedOwner) {
      try {
        // Recheck active DB identity. A revoked/suspended session must not pass.
        const active = await pool.query(
          `SELECT 1 FROM public.users WHERE id=$1 AND lower(btrim(email))=$2
             AND company_id=1 AND lower(btrim(role))='owner'
             AND is_active IS TRUE AND lower(btrim(status))='active' LIMIT 1`,
          ["google_103728868378401731050", "admcst001@gmail.com"],
        );
        ownerVerified = active.rowCount === 1;
      } catch {
        res.status(503).json({
          ready: false, readOnly: true, dedicatedConnectionVerified: false,
          code: "PAYROLL_PROD_OWNER_VERIFICATION_UNAVAILABLE",
        });
        return;
      }
    }
    if (!isSuperAdmin && !ownerVerified) {
      res.status(403).json({ message: "Pemeriksaan koneksi Payroll hanya untuk Super Admin atau Owner CST terverifikasi." });
      return;
    }

    let configured: boolean;
    try {
      configured = payrollReadOnlyReady();
    } catch (error) {
      // Explicit allowlist: never return the URL, password, username, host or raw DB error.
      const safeReasons = new Set([
        "PAYROLL_PROD_URL_MALFORMED",
        "PAYROLL_PROD_URL_SCHEME_INVALID",
        "PAYROLL_PROD_PROJECT_MISMATCH",
        "PAYROLL_PROD_USERNAME_MISMATCH",
        "PAYROLL_PROD_HOST_MISMATCH",
        "PAYROLL_PROD_POOLER_USERNAME_SUFFIX_REQUIRED",
        "PAYROLL_PROD_DATABASE_NAME_MISSING",
      ]);
      const rawReason=error instanceof Error ? error.message : "";
      res.status(503).json({
        ready: false, readOnly: true, dedicatedConnectionVerified: false,
        code: "PAYROLL_PROD_DEDICATED_CONFIG_INVALID",
        reasonCode: safeReasons.has(rawReason) ? rawReason : "PAYROLL_PROD_URL_MALFORMED",
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
      const shared=payrollProdSharedReadOnlyEnabled();
      res.status(200).json({
        ready: true,
        readOnly: true,
        connectionMode: shared ? "BIZPORTAL_SHARED_ROLE_SCOPED_READ_ONLY" : "DEDICATED_ROLE_SCOPED_READ_ONLY",
        dedicatedConnectionVerified: !shared,
        sharedRoleScopedVerified: shared,
        companyScopeVerified: true,
        roleVerified: true,
        canPay: false,
        canPostJournal: false,
        canApprove: false,
        canWriteKasbon: false,
      });
    } catch (error) {
      // Deliberately do not serialize DB errors, URLs, credentials, query text or
      // the failing SQL. Only a predefined, non-sensitive diagnosis is returned.
      res.status(503).json({
        ready: false, readOnly: true, dedicatedConnectionVerified: false,
        code: "PAYROLL_PROD_DATABASE_READINESS_FAILED",
        reasonCode: payrollReadinessSafeReason(error),
      });
    }
  });
}
