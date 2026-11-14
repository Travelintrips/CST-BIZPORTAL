import type { IRouter, Request, Response } from "express";
import { payrollReadOnlyReady, payrollScopedQuery } from "./payroll-prod-db";

type ScopedRequest = Request & {
  payrollCompanyId?: number;
  payrollActor?: { role: string };
};

type HistoricalSalaryRow = {
  id: number | string; firstName: string; lastName: string;
  sourceRunId: number | string | null;
  sourceYear: number | string | null; sourceMonth: number | string | null;
  sourceBaseSalary: string | null; historicalKasbon: string | null;
  savedEffectiveFrom: string | null;
};

function positiveInt(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}
const moneyPattern = /^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,2})?$/;

export function registerPayrollHistoricalSalaryReviewRoutes(router: IRouter): void {
  router.get("/payroll/historical-salary-review", async (req: ScopedRequest, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    if (!["owner","super_admin"].includes(req.payrollActor?.role?.trim().toLowerCase() ?? "")) {
      res.status(403).json({message:"Hanya Owner atau Super Admin boleh melihat referensi gaji historis."});
      return;
    }
    if (process.env.APP_ENV?.trim().toLowerCase() !== "production" || !payrollReadOnlyReady()) {
      res.status(503).json({message:"Referensi gaji historis memerlukan Payroll PROD baca-saja yang terverifikasi."});
      return;
    }
    const companyId = req.payrollCompanyId;
    const year = positiveInt(req.query.year,2020,2099);
    const month = positiveInt(req.query.month,1,12);
    if (!Number.isSafeInteger(companyId) || !companyId || companyId <= 0 || year===null || month===null) {
      res.status(400).json({message:"Perusahaan, tahun, atau bulan tidak valid."});
      return;
    }
    const cutoff = new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);

    try {
      // Historical items are a reference only, never a current HR salary approval.
      // No access to public.employees.salary or legacy master data is requested.
      // All SELECTs execute as payroll role with company RLS under BEGIN READ ONLY.
      const result=await payrollScopedQuery(companyId, `
        SELECT e.id, e.first_name AS "firstName", e.last_name AS "lastName",
               h.run_id AS "sourceRunId", h.year AS "sourceYear",
               h.month AS "sourceMonth",
               h.base_salary::text AS "sourceBaseSalary",
               h.kasbon_deduction::text AS "historicalKasbon",
               p.effective_from::text AS "savedEffectiveFrom"
        FROM public.employees e
        LEFT JOIN LATERAL (
          SELECT pi.run_id,r.year,r.month,pi.base_salary,pi.kasbon_deduction
          FROM public.payroll_items pi
          INNER JOIN public.payroll_runs r ON r.id=pi.run_id
          WHERE pi.employee_id=e.id AND r.company_id=$1
            AND (r.year*12+r.month) < ($2::int*12+$3::int)
            AND r.status='approved' AND r.posting_status='posted'
          ORDER BY r.year DESC,r.month DESC,r.id DESC LIMIT 1
        ) h ON TRUE
        LEFT JOIN LATERAL (
          SELECT p.effective_from
          FROM public.payroll_salary_profiles p
          WHERE p.employee_id=e.id AND p.company_id=$1 AND p.effective_from<=$4::date
          ORDER BY p.effective_from DESC,p.id DESC LIMIT 1
        ) p ON TRUE
        WHERE e.company_id=$1 AND e.status='active' AND e.deleted_at IS NULL
        ORDER BY e.first_name,e.last_name,e.id
        LIMIT 300
      `,[companyId,year,month,cutoff]);
      const rows=(result.rows as HistoricalSalaryRow[]).map(row=>{
        const employeeId=Number(row.id);
        const sourceRunId=row.sourceRunId===null?null:Number(row.sourceRunId);
        const sourceYear=row.sourceYear===null?null:Number(row.sourceYear);
        const sourceMonth=row.sourceMonth===null?null:Number(row.sourceMonth);
        if (!Number.isSafeInteger(employeeId)||employeeId<1||
            (sourceRunId!==null && (!Number.isSafeInteger(sourceRunId)||sourceRunId<1))||
            (sourceYear!==null && (!Number.isSafeInteger(sourceYear)||sourceYear<2020))||
            (sourceMonth!==null && (!Number.isInteger(sourceMonth)||sourceMonth<1||sourceMonth>12)))
          throw Error("PAYROLL_HISTORICAL_REVIEW_INVALID_RESULT");
        const sourceSalary=row.sourceBaseSalary;
        const saved=row.savedEffectiveFrom!==null;
        const candidateValid=typeof sourceSalary==="string" &&
          moneyPattern.test(sourceSalary) && Number(sourceSalary)>0;
        const status=saved?"ALREADY_CONFIGURED" :
          sourceRunId===null?"NO_HISTORICAL_SOURCE" :
          candidateValid?"NEEDS_HR_CONFIRMATION":"INVALID_HISTORICAL_SOURCE";
        return {
          employeeId, employeeName:`${row.firstName??""} ${row.lastName??""}`.trim(),
          sourceRunId, sourceYear, sourceMonth,
          proposedBaseSalary:candidateValid?sourceSalary:null,
          historicalKasbonNeedsReview:row.historicalKasbon!==null &&
            Number(row.historicalKasbon)>0,
          alreadyConfigured:saved, status,
        };
      });
      const summary={
        employeeCount:rows.length,
        candidatesNeedingHrConfirmation:rows.filter(r=>r.status==="NEEDS_HR_CONFIRMATION").length,
        noHistoricalSource:rows.filter(r=>r.status==="NO_HISTORICAL_SOURCE").length,
        invalidHistoricalSource:rows.filter(r=>r.status==="INVALID_HISTORICAL_SOURCE").length,
        alreadyConfigured:rows.filter(r=>r.status==="ALREADY_CONFIGURED").length,
        historicalKasbonNeedsReview:rows.filter(r=>r.historicalKasbonNeedsReview).length,
      };
      res.json({
        companyId,year,month,effectiveThrough:cutoff,
        sourcePolicy:"APPROVED_AND_POSTED_BEFORE_TARGET_MONTH",
        summary,rows,
        // No bulk approval/import or writes are enabled by this GET.
        reviewRequired:true,canBulkImport:false,canApply:false,
        canPay:false,canPostJournal:false,readOnly:true,
      });
    }catch {
      res.status(503).json({message:"Pratinjau gaji historis gagal dibaca. Tidak ada data diubah."});
    }
  });
}
