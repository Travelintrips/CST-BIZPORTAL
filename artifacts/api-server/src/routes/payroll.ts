import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { pool } from "@workspace/db";
import { authorizePayrollCompany } from "./payroll-access";
import { getDevSession, getProductionSession, getProductionUser, isDevelopmentEnvironment, type DevAuthUser } from "./dev-auth";

/**
 * Standalone Payroll adapter: read-only until the legacy calculation,
 * kasbon allocation and accounting-posting services are ported and tested.
 * DO NOT fabricate calculated or paid statuses from a reduced implementation.
 */
const router: IRouter = Router();
type PayrollRequest = Request & { payrollActor?: DevAuthUser; payrollCompanyId?: number };
async function authorize(request: PayrollRequest, response: Response, next: NextFunction): Promise<void> {
  try {
    const actor = isDevelopmentEnvironment()
      ? getDevSession(request)
      : await (async () => {
          const session = getProductionSession(request);
          return session ? getProductionUser(session) : null;
        })();
    if (!actor) { response.status(401).json({ message: "Sesi tidak tersedia." }); return; }
    const companyId = authorizePayrollCompany(actor, request.query.companyId);
    if (companyId === null) { response.status(403).json({ message: "Akses payroll perusahaan ditolak." }); return; }
    request.payrollActor = actor;
    request.payrollCompanyId = companyId;
    next();
  } catch (error) {
    request.log.error({ error }, "Payroll authorization error");
    response.status(503).json({ message: "Otorisasi payroll tidak tersedia." });
  }
}

const positiveId = (raw: string | undefined): number | null => {
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
};
function serializeRun(row: Record<string, unknown>) {
  const status = String(row.status ?? "draft");
  const accountingId = row.accounting_entry_id;
  const paymentId = row.payment_entry_id;
  let integrityError: string | null = null;
  if (status === "approved" && !accountingId) integrityError = "Payroll disetujui tanpa jurnal akrual.";
  if (status === "paid" && (!accountingId || !paymentId)) integrityError = "Payroll dibayar tanpa jurnal lengkap.";
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    month: Number(row.month),
    year: Number(row.year),
    status,
    postingStatus: String(row.posting_status ?? "pending"),
    integrityError,
  };
}

router.use("/payroll", authorize);

router.get("/payroll/runs", async (req: PayrollRequest, res): Promise<void> => {
  const companyId = req.payrollCompanyId!;
  try {
    const rows = await pool.query(
      `SELECT id, company_id, month, year, status, posting_status, accounting_entry_id, payment_entry_id
         FROM public.payroll_runs WHERE company_id = $1
        ORDER BY year DESC, month DESC, id DESC LIMIT 250`,
      [companyId],
    );
    res.json({ runs: rows.rows.map(serializeRun) });
  } catch (error) {
    req.log.error({ error, companyId }, "Payroll runs read failed");
    res.status(503).json({ message: "Riwayat payroll tidak dapat dimuat." });
  }
});

router.get("/payroll/runs/:id", async (req: PayrollRequest, res): Promise<void> => {
  const companyId = req.payrollCompanyId!;
  const runId = positiveId(req.params.id);
  if (!runId) { res.status(400).json({ message: "ID payroll tidak valid." }); return; }
  try {
    const result = await pool.query(
      `SELECT id, company_id, month, year, status, posting_status, accounting_entry_id, payment_entry_id
         FROM public.payroll_runs WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, runId],
    );
    if (!result.rowCount) { res.status(404).json({ message: "Periode tidak ditemukan di perusahaan ini." }); return; }
    const items = await pool.query(
      `SELECT pi.id, pi.employee_id, pi.base_salary, pi.allowance, pi.gross_salary,
              pi.kasbon_deduction, pi.total_deductions, pi.net_salary,
              e.first_name, e.last_name
         FROM public.payroll_items pi
         JOIN public.employees e ON e.id = pi.employee_id AND e.company_id = $1
        WHERE pi.run_id = $2 ORDER BY e.first_name, e.last_name, pi.id`,
      [companyId, runId],
    );
    const run = serializeRun(result.rows[0]);
    res.json({
      run,
      integrityError: run.integrityError,
      items: items.rows.map((row) => ({
        item: {
          id: Number(row.id), employeeId: Number(row.employee_id),
          baseSalary: row.base_salary, allowance: row.allowance,
          grossSalary: row.gross_salary, kasbonDeduction: row.kasbon_deduction,
          totalDeductions: row.total_deductions, netSalary: row.net_salary,
        },
        employee: { firstName: row.first_name, lastName: row.last_name },
      })),
    });
  } catch (error) {
    req.log.error({ error, companyId, runId }, "Payroll run detail read failed");
    res.status(503).json({ message: "Rincian payroll tidak dapat dimuat." });
  }
});

// Calculate, approval, salary disbursement and journal posting are deliberately
// absent from this adapter. Requests fail closed instead of mutating financial data.
router.post("/payroll/runs", (_req, res) => {
  res.status(501).json({ message: "Pembuatan payroll belum diaktifkan sampai migrasi dan pengujian DEV selesai." });
});
router.post("/payroll/runs/:id/generate-items", (_req, res) => {
  res.status(501).json({ message: "Generate payroll belum diaktifkan sampai validasi master karyawan selesai." });
});
router.post("/payroll/runs/:id/calculate", (_req, res) => {
  res.status(501).json({ message: "Perhitungan kasbon belum diporting dan belum diverifikasi." });
});

export default router;
