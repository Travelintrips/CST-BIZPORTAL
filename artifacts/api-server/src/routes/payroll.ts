import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { pool } from "@workspace/db";
import { authorizePayrollCompany } from "./payroll-access";
import { getDevSession, getProductionSession, getProductionUser, isDevelopmentEnvironment, type DevAuthUser } from "./dev-auth";

/**
 * Standalone Payroll adapter: scoped reads and opt-in DEV-only Draft writes.
 * Production writes, calculation, kasbon settlement and accounting posting remain disabled.
 * DO NOT fabricate calculated or paid statuses from a reduced implementation.
 */
const router: IRouter = Router();
type PayrollRequest = Request & { payrollActor?: DevAuthUser; payrollCompanyId?: number };
async function authorize(request: PayrollRequest, response: Response, next: NextFunction): Promise<void> {
  try {
    // BizPortal uses Supabase-exchanged application sessions in both DEV and PROD.
    // The isolated DEV cookie remains an explicit development-only fallback.
    const session = getProductionSession(request);
    const actor = session
      ? await getProductionUser(session)
      : isDevelopmentEnvironment() ? getDevSession(request) : null;
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
              pi.bpjs_jht_employee, pi.bpjs_kes_employee, pi.pph21, pi.other_deductions,
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
          bpjsJhtEmployee: row.bpjs_jht_employee, bpjsKesEmployee: row.bpjs_kes_employee,
          pph21: row.pph21, otherDeductions: row.other_deductions,
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
    canEditItems: isDevelopmentEnvironment()
      && process.env.PAYROLL_DEV_ITEM_EDIT_ENABLED === "true"
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
/**
 * DEV-only edits to non-kasbon salary fields. Recompute net in one transaction.
 * Do not settle advances or post any ledger changes.
 */
router.patch("/payroll/runs/:id/items/:itemId", async (req: PayrollRequest, res): Promise<void> => {
  if (!isDevelopmentEnvironment() || process.env.PAYROLL_DEV_ITEM_EDIT_ENABLED !== "true") {
    res.status(501).json({ message: "Edit komponen gaji belum diaktifkan." }); return;
  }
  if (!["admin", "owner", "super_admin"].includes(req.payrollActor?.role.toLowerCase() ?? "")) {
    res.status(403).json({ message: "Tidak berwenang mengubah gaji." }); return;
  }
  const runId = positiveId(req.params.id);
  const itemId = positiveId(req.params.itemId);
  if (!runId || !itemId) { res.status(400).json({ message: "ID payroll/item tidak valid." }); return; }

  const fields = ["baseSalary", "allowance", "bpjsJhtEmployee", "bpjsKesEmployee", "pph21", "otherDeductions"] as const;
  const data = req.body;
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).length === 0 || Object.keys(data).some((key) => !fields.includes(key as typeof fields[number]))) {
    res.status(400).json({ message: "Hanya komponen gaji yang diizinkan dapat diubah." }); return;
  }
  const updates: Record<string, number> = {};
  for (const field of fields) {
    if (!(field in data)) continue;
    const raw = data[field];
    if ((typeof raw !== "number" && typeof raw !== "string") ||
        (typeof raw === "string" && !/^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,2})?$/.test(raw)) ||
        raw === "") {
      res.status(400).json({ message: `Nilai ${field} tidak valid.` }); return;
    }
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000_000 ||
        Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
      res.status(400).json({ message: `Nilai ${field} harus positif dan maksimal dua desimal.` }); return;
    }
    updates[field] = amount;
  }

  const companyId = req.payrollCompanyId!;
  try {
    const client = await pool.connect();
    let activeTransaction = false;
    try {
      await client.query("BEGIN");
      activeTransaction = true;
      await client.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [companyId, -runId]);
      const run = await client.query(
        "SELECT id, status FROM public.payroll_runs WHERE company_id = $1 AND id = $2 FOR UPDATE", [companyId, runId],
      );
      if (!run.rowCount) {
        await client.query("ROLLBACK"); activeTransaction = false;
        res.status(404).json({ message: "Periode bukan milik perusahaan ini." }); return;
      }
      if (run.rows[0].status !== "draft") {
        await client.query("ROLLBACK"); activeTransaction = false;
        res.status(409).json({ message: "Item hanya dapat diubah ketika periode Draft." }); return;
      }
      const itemResult = await client.query(
        `SELECT pi.id, pi.base_salary, pi.allowance, pi.bpjs_jht_employee, pi.bpjs_kes_employee,
                pi.pph21, pi.other_deductions, pi.kasbon_deduction
         FROM public.payroll_items pi
         JOIN public.employees e ON e.id = pi.employee_id AND e.company_id = $1
         WHERE pi.id = $2 AND pi.run_id = $3 FOR UPDATE OF pi`,
        [companyId, itemId, runId],
      );
      if (!itemResult.rowCount) {
        await client.query("ROLLBACK"); activeTransaction = false;
        res.status(404).json({ message: "Item bukan milik perusahaan ini." }); return;
      }
      const item = itemResult.rows[0];
      const take = (field: typeof fields[number], column: string) => updates[field] ?? Number(item[column]);
      const base = take("baseSalary", "base_salary");
      const allowance = take("allowance", "allowance");
      const bpjsJht = take("bpjsJhtEmployee", "bpjs_jht_employee");
      const bpjsKes = take("bpjsKesEmployee", "bpjs_kes_employee");
      const pph21 = take("pph21", "pph21");
      const other = take("otherDeductions", "other_deductions");
      const kasbon = Number(item.kasbon_deduction);
      const gross = base + allowance;
      const deductions = bpjsJht + bpjsKes + pph21 + other + kasbon;
      const net = gross - deductions;
      if (![gross, deductions, net].every(Number.isFinite) || net < 0) {
        await client.query("ROLLBACK"); activeTransaction = false;
        res.status(409).json({ message: "Potongan lebih besar dari gaji kotor." }); return;
      }
      const result = await client.query(
        `UPDATE public.payroll_items
         SET base_salary=$1, allowance=$2, bpjs_jht_employee=$3, bpjs_kes_employee=$4,
             pph21=$5, other_deductions=$6, gross_salary=$7, total_deductions=$8, net_salary=$9
         WHERE id=$10 AND run_id=$11 RETURNING id, base_salary, allowance, gross_salary,
             total_deductions, net_salary, kasbon_deduction`,
        [base, allowance, bpjsJht, bpjsKes, pph21, other, gross, deductions, net, itemId, runId],
      );
      await client.query("COMMIT");
      activeTransaction = false;
      res.json({ item: result.rows[0] });
    } catch (error) {
      if (activeTransaction) {
        try { await client.query("ROLLBACK"); } catch (rollbackError) {
          req.log.error({ rollbackError }, "Payroll item edit rollback failed");
        }
      }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    req.log.error({ error, companyId, runId, itemId }, "Payroll item edit failed");
    res.status(503).json({ message: "Item payroll tidak dapat diubah." });
  }
});

router.post("/payroll/runs/:id/calculate", (_req, res) => {
  res.status(501).json({ message: "Perhitungan kasbon belum diporting dan belum diverifikasi." });
});

export default router;
