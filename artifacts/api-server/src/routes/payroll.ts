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

const positiveId = (raw: unknown): number | null => {
  if (typeof raw !== "string") return null;
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
router.get("/payroll/capabilities", (req: PayrollRequest, res) => {
  res.json({
    companyId: req.payrollCompanyId,
    canCreateDraft: isDevelopmentEnvironment()
      && process.env.PAYROLL_DEV_DRAFT_ENABLED === "true"
      && ["admin", "owner", "super_admin"].includes(req.payrollActor?.role.toLowerCase() ?? ""),
    canGenerate: isDevelopmentEnvironment()
      && process.env.PAYROLL_DEV_GENERATE_ENABLED === "true"
      && ["admin", "owner", "super_admin"].includes(req.payrollActor?.role.toLowerCase() ?? ""),
    canCalculate: false,
    canApprove: false,
    canPay: false,
  });
});

/**
 * DEV-only opt-in. No payroll_items, cash-advance, payment or journal writes.
 * Serializes duplicate period creation with a transaction-scoped advisory lock.
 */
router.post("/payroll/runs", async (req: PayrollRequest, res): Promise<void> => {
  if (!isDevelopmentEnvironment() || process.env.PAYROLL_DEV_DRAFT_ENABLED !== "true") {
    res.status(501).json({ message: "Pembuatan draft payroll belum diaktifkan untuk lingkungan ini." });
    return;
  }
  if (!["admin", "owner", "super_admin"].includes(req.payrollActor?.role.toLowerCase() ?? "")) {
    res.status(403).json({ message: "Tidak berwenang membuat periode payroll." });
    return;
  }
  const { month, year, notes } = req.body ?? {};
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2020 || year > 2100
    || (notes !== undefined && (typeof notes !== "string" || notes.length > 500))) {
    res.status(400).json({ message: "Bulan, tahun, atau catatan tidak valid." });
    return;
  }
  const companyId = req.payrollCompanyId!;
  try {
    const client = await pool.connect();
    let activeTransaction = false;
    try {
      await client.query("BEGIN");
      activeTransaction = true;
      await client.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [companyId, year * 100 + month]);
      const existing = await client.query(
        "SELECT id FROM public.payroll_runs WHERE company_id = $1 AND month = $2 AND year = $3 LIMIT 1",
        [companyId, month, year],
      );
      if (existing.rowCount) {
        await client.query("ROLLBACK");
        activeTransaction = false;
        res.status(409).json({ message: "Periode payroll perusahaan ini sudah ada." });
        return;
      }
      const inserted = await client.query(
        `INSERT INTO public.payroll_runs (company_id, month, year, notes, status)
         VALUES ($1, $2, $3, $4, 'draft')
         RETURNING id, company_id, month, year, status, posting_status, accounting_entry_id, payment_entry_id`,
        [companyId, month, year, notes?.trim() || null],
      );
      await client.query("COMMIT");
      activeTransaction = false;
      res.status(201).json({ run: serializeRun(inserted.rows[0]) });
    } catch (error) {
      if (activeTransaction) {
        try { await client.query("ROLLBACK"); } catch (rollbackError) {
          req.log.error({ rollbackError }, "Payroll draft rollback failed");
        }
      }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    req.log.error({ error, companyId }, "Payroll draft create failed");
    res.status(503).json({ message: "Draft payroll tidak dapat dibuat." });
  }
});
/** DEV-only, opt-in: create missing employee items without rewriting existing amounts. */
router.post("/payroll/runs/:id/generate-items", async (req: PayrollRequest, res): Promise<void> => {
  if (!isDevelopmentEnvironment() || process.env.PAYROLL_DEV_GENERATE_ENABLED !== "true") {
    res.status(501).json({ message: "Generate payroll belum diaktifkan di lingkungan ini." });
    return;
  }
  if (!["admin", "owner", "super_admin"].includes(req.payrollActor?.role.toLowerCase() ?? "")) {
    res.status(403).json({ message: "Tidak berwenang memuat karyawan ke payroll." });
    return;
  }
  const runId = positiveId(req.params.id);
  if (!runId) { res.status(400).json({ message: "ID payroll tidak valid." }); return; }
  const companyId = req.payrollCompanyId!;
  try {
    const client = await pool.connect();
    let activeTransaction = false;
    try {
      await client.query("BEGIN");
      activeTransaction = true;
      // Serialise item generation and edits for the same run.
      await client.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [companyId, -runId]);
      const run = await client.query(
        "SELECT id, status FROM public.payroll_runs WHERE id = $1 AND company_id = $2 FOR UPDATE",
        [runId, companyId],
      );
      if (!run.rowCount) {
        await client.query("ROLLBACK");
        activeTransaction = false;
        res.status(404).json({ message: "Periode payroll tidak ditemukan di perusahaan ini." });
        return;
      }
      if (run.rows[0].status !== "draft") {
        await client.query("ROLLBACK");
        activeTransaction = false;
        res.status(409).json({ message: "Hanya periode berstatus Draft yang dapat memuat karyawan." });
        return;
      }
      // Salary must be valid for every active employee; fail the whole operation rather than silently zeroing pay.
      const invalid = await client.query(
        `SELECT count(*)::integer AS invalid_count FROM public.employees
         WHERE company_id = $1 AND status = 'active' AND deleted_at IS NULL
           AND (salary IS NULL OR salary <= 0 OR salary::text IN ('NaN', 'Infinity', '-Infinity'))`,
        [companyId],
      );
      if (Number(invalid.rows[0]?.invalid_count ?? 0) > 0) {
        await client.query("ROLLBACK");
        activeTransaction = false;
        res.status(409).json({ message: "Ada karyawan aktif tanpa gaji pokok valid. Lengkapi master karyawan dahulu." });
        return;
      }
      const inserted = await client.query(
        `INSERT INTO public.payroll_items (
             run_id, employee_id, base_salary, allowance, gross_salary, total_deductions, net_salary
           )
           SELECT $1, e.id, round(e.salary::numeric, 2), 0, round(e.salary::numeric, 2), 0, round(e.salary::numeric, 2)
           FROM public.employees e
           WHERE e.company_id = $2 AND e.status = 'active' AND e.deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM public.payroll_items p WHERE p.run_id = $1 AND p.employee_id = e.id
             )
           RETURNING id`,
        [runId, companyId],
      );
      await client.query("COMMIT");
      activeTransaction = false;
      res.json({ added: inserted.rowCount ?? inserted.rows.length, runId, companyId });
    } catch (error) {
      if (activeTransaction) {
        try { await client.query("ROLLBACK"); } catch (rollbackError) {
          req.log.error({ rollbackError }, "Payroll item generation rollback failed");
        }
      }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    req.log.error({ error, runId, companyId }, "Payroll item generation failed");
    res.status(503).json({ message: "Daftar payroll tidak dapat dibuat." });
  }
});
router.post("/payroll/runs/:id/calculate", (_req, res) => {
  res.status(501).json({ message: "Perhitungan kasbon belum diporting dan belum diverifikasi." });
});

export default router;
