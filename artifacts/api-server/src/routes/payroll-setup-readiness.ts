import type { IRouter, Request, Response } from "express";
import { payrollReadOnlyReady, payrollScopedQuery } from "./payroll-prod-db";

type ScopedPayrollRequest = Request & {
  payrollCompanyId?: number;
  payrollActor?: { role: string };
};

/**
 * Data completeness for one authenticated payroll company and month, independent
 * of Draft creation. Never reads individual salary amounts into the response.
 * No calculations, financial writes, approvals, journals or payments.
 */
export function registerPayrollSetupReadinessRoutes(router: IRouter): void {
  router.get("/payroll/setup-readiness", async (req: ScopedPayrollRequest, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    const role = req.payrollActor?.role?.toLowerCase() ?? "";
    if (!["owner", "super_admin"].includes(role)) {
      res.status(403).json({ message: "Kesiapan komponen gaji hanya untuk Owner atau Super Admin." });
      return;
    }
    if (process.env.APP_ENV?.trim().toLowerCase() !== "production" || !payrollReadOnlyReady()) {
      res.status(503).json({ message: "Kesiapan Payroll baca-saja belum diaktifkan pada lingkungan ini." });
      return;
    }
    const companyId = req.payrollCompanyId;
    const rawYear = req.query.year;
    const rawMonth = req.query.month;
    const year = typeof rawYear === "string" && /^20[0-9]{2}$/.test(rawYear) ? Number(rawYear) : NaN;
    const month = typeof rawMonth === "string" && /^(?:[1-9]|1[0-2])$/.test(rawMonth) ? Number(rawMonth) : NaN;
    if (!Number.isSafeInteger(companyId) || !companyId || companyId < 1 ||
        !Number.isInteger(year) || year < 2020 || year > 2099 || !Number.isInteger(month)) {
      res.status(400).json({ message: "Perusahaan atau bulan dan tahun Payroll tidak valid." });
      return;
    }

    const effectiveThrough = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    try {
      // All reads run on the role-scoped, company-scoped, read-only connection.
      // Latest effective salary and latest effective deduction per code win.
      const result = await payrollScopedQuery(companyId, `
        SELECT
          COUNT(*)::int AS "employeeCount",
          COUNT(*) FILTER (WHERE s.id IS NOT NULL)::int AS "salaryConfiguredCount",
          COUNT(*) FILTER (WHERE s.id IS NULL)::int AS "missingSalaryCount",
          COUNT(*) FILTER (WHERE d.code_count=5)::int AS "deductionConfiguredCount",
          COUNT(*) FILTER (WHERE d.code_count<5)::int AS "missingDeductionCount",
          COUNT(*) FILTER (WHERE s.id IS NOT NULL AND
            (s.base_salary<=0 OR s.allowance<0))::int AS "invalidSalaryCount",
          COUNT(*) FILTER (WHERE d.negative_count>0 OR
            (s.id IS NOT NULL AND d.code_count=5 AND
             d.total_deductions>s.base_salary+s.allowance))::int AS "invalidDeductionCount",
          COUNT(*) FILTER (WHERE s.id IS NOT NULL AND s.base_salary>0 AND s.allowance>=0 AND
            d.code_count=5 AND d.negative_count=0 AND
            d.total_deductions<=s.base_salary+s.allowance)::int AS "readyEmployeeCount"
        FROM public.employees e
        LEFT JOIN LATERAL (
          SELECT s.id,s.base_salary,s.allowance
          FROM public.payroll_salary_profiles s
          WHERE s.company_id=$1 AND s.employee_id=e.id AND s.effective_from<=$2::date
          ORDER BY s.effective_from DESC,s.id DESC LIMIT 1
        ) s ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS code_count,
                 COUNT(*) FILTER (WHERE d.amount<0)::int AS negative_count,
                 COALESCE(SUM(d.amount),0) AS total_deductions
          FROM (
            SELECT DISTINCT ON (code) code,amount
            FROM public.payroll_deduction_settings d
            WHERE d.company_id=$1 AND d.employee_id=e.id AND d.effective_from<=$2::date
              AND d.code IN ('bpjs_jht_employee','bpjs_kes_employee','pph21',
                             'other_deductions','kasbon_deduction')
            ORDER BY code,effective_from DESC,id DESC
          ) d
        ) d ON TRUE
        WHERE e.company_id=$1 AND e.status='active' AND e.deleted_at IS NULL
      `, [companyId, effectiveThrough]);
      const row = result.rows[0];
      if (result.rowCount !== 1 || !row) throw Error("PAYROLL_READINESS_AGGREGATE_INVALID");
      const fields = [
        "employeeCount","salaryConfiguredCount","missingSalaryCount","deductionConfiguredCount",
        "missingDeductionCount","invalidSalaryCount","invalidDeductionCount","readyEmployeeCount",
      ] as const;
      const counters: Record<string, number> = {};
      for (const field of fields) {
        const n = Number(row[field]);
        if (!Number.isSafeInteger(n) || n < 0) throw Error("PAYROLL_READINESS_COUNT_INVALID");
        counters[field] = n;
      }
      const dataComplete = counters.employeeCount > 0 &&
        counters.readyEmployeeCount === counters.employeeCount;
      res.status(200).json({
        companyId, year, month, effectiveThrough, ...counters,
        dataComplete, canCreateDraft: false, canApprove: false,
        canPay: false, canPostJournal: false, readOnly: true,
      });
    } catch {
      res.status(503).json({ message: "Rekap kesiapan Payroll belum dapat dihitung. Tidak ada data diubah." });
    }
  });
}
