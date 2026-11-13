import { type IRouter, type Request, type Response } from "express";
import type { PayrollDbClient } from "@workspace/db";
import { getPayrollPool, payrollDedicatedEnabled, payrollProdDedicatedRequired, payrollReadOnlyReady, payrollScopedQuery, setPayrollCompanyScope } from "./payroll-prod-db";
import { isDevelopmentEnvironment } from "./dev-auth";
import { createHash } from "node:crypto";
import {loadAutoKasbonSources} from "./payroll-kasbon-draft-db";
import {overlayAutomaticKasbon,finalizeAutomaticKasbonPreview} from "./payroll-kasbon-draft-overlay";
import {
  buildEffectiveSetupPreview, periodEnd,
  type EffectiveDeductionRow, type EffectiveSalaryRow,
} from "./payroll-setup-effective-preview";

type ScopedRequest = Request & { payrollCompanyId?: number; payrollActor?: { role: string } };
export function setupDigest(preview: ReturnType<typeof buildEffectiveSetupPreview>): string {
  return createHash("sha256").update(JSON.stringify({ effectiveThrough: preview.effectiveThrough, rows: preview.rows })).digest("hex");
}
function positiveId(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}
function parseSampleEmployeeIds(raw: unknown, year: number, month: number): number[] | null {
  if (raw === undefined) return null;
  // Test employee subsets are never accepted in canonical production.
  if (!isDevelopmentEnvironment()) throw new Error("SAMPLE_SCOPE_NOT_ALLOWED_IN_PROD");
  if (year !== 2099 || month !== 12) throw new Error("SAMPLE_SCOPE_ONLY_TEST_PERIOD");
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : null;
  if (!values || values.length < 1 || values.length > 5) throw new Error("INVALID_SAMPLE_EMPLOYEE_LIST");
  const ids = values.map(value => {
    const parsed = typeof value === "number" ? value :
      typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("INVALID_SAMPLE_EMPLOYEE_ID");
    return parsed;
  });
  if (new Set(ids).size !== ids.length) throw new Error("DUPLICATE_SAMPLE_EMPLOYEE_ID");
  return ids.sort((a,b) => a-b);
}
function matchesSampleRoster(rows: Array<{employeeId: number|string}>, ids: number[] | null): boolean {
  if (ids === null) return true;
  const actual = rows.map(row => Number(row.employeeId)).sort((a,b) => a-b);
  return actual.length === ids.length && actual.every((id,index) => id === ids[index]);
}

function canApplyEffectiveSetup(req: ScopedRequest): boolean {
  const role=req.payrollActor?.role?.toLowerCase() ?? "";
  if(isDevelopmentEnvironment()) return payrollDedicatedEnabled() &&
    process.env.PAYROLL_DEV_SETUP_APPLY_ENABLED === "true" &&
    ["admin","owner","super_admin"].includes(role);
  return payrollProdDedicatedRequired() &&
    process.env.PAYROLL_PROD_SETUP_APPLY_ENABLED === "true" &&
    role === "super_admin";
}
function effectiveSetupReadReady(): boolean {
  return isDevelopmentEnvironment() ? payrollDedicatedEnabled() : payrollReadOnlyReady();
}

/**
 * Read-only bridge from effective dated configuration to Draft Payroll.
 * Deliberately NOT mounted as item generation and never updates payroll_runs,
 * payroll_items, cash advances, approvals, payments, or GL.
 */
export function registerEffectiveSetupPreviewRoutes(router: IRouter): void {

  // Explicit opt-in materialization: no existing payroll item is modified.
  router.post("/payroll/runs/:id/apply-setup", async (req: ScopedRequest, res: Response): Promise<void> => {
    if (!canApplyEffectiveSetup(req)) {
      const configured = isDevelopmentEnvironment()
        ? payrollDedicatedEnabled() && process.env.PAYROLL_DEV_SETUP_APPLY_ENABLED === "true"
        : payrollProdDedicatedRequired() && process.env.PAYROLL_PROD_SETUP_APPLY_ENABLED === "true";
      res.status(configured ? 403 : 501)
        .json({ message: "Penerapan struktur gaji belum diaktifkan untuk lingkungan ini atau pengguna tidak berwenang." }); return;
    }
    if (!effectiveSetupReadReady()) {
      res.status(503).json({ message: "Koneksi database Payroll khusus tidak tersedia." }); return;
    }
    const runId = positiveId(req.params.id);
    const digest = req.body?.expectedDigest;
    if (!runId || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest) || req.body?.confirm !== true) {
      res.status(400).json({ message: "ID, konfirmasi, atau sidik pratinjau tidak valid." }); return;
    }
    const companyId = req.payrollCompanyId!;
    let client: PayrollDbClient | undefined;
    let started = false;
    try {
      client = await getPayrollPool().connect();
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      started = true;
      await setPayrollCompanyScope(client, companyId);
      // Same lock namespace as the old generate-items flow.
      await client.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)", [companyId, -runId]);
      // Serialize kasbon planning and Draft materialization for this company.
      await client.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)", [companyId, -100000001]);
      const run = await client.query(
        "SELECT month,year,status FROM public.payroll_runs WHERE company_id=$1::bigint AND id=$2::bigint",
        [companyId, runId]);
      if (run.rowCount !== 1) { await client.query("ROLLBACK"); started = false; res.status(404).json({ message: "Draft perusahaan tidak ditemukan." }); return; }
      if (run.rows[0].status !== "draft") { await client.query("ROLLBACK"); started = false; res.status(409).json({ message: "Periode tidak lagi berstatus Draft." }); return; }
      const {year,month} = run.rows[0];
      let sampleIds: number[] | null;
      try { sampleIds=parseSampleEmployeeIds(req.body?.sampleEmployeeIds,Number(year),Number(month)); }
      catch(error) {
        await client.query("ROLLBACK"); started=false;
        res.status(400).json({message:error instanceof Error?error.message:"INVALID_SAMPLE_SCOPE"}); return;
      }
      const cutoff = periodEnd(Number(year),Number(month));
      const employees = await client.query(`SELECT e.id AS "employeeId", e.first_name AS "firstName", e.last_name AS "lastName",
        s.base_salary::text AS "baseSalary",s.allowance::text AS "allowance",s.effective_from::text AS "salaryEffectiveFrom"
        FROM public.employees e LEFT JOIN LATERAL (
          SELECT base_salary,allowance,effective_from FROM public.payroll_salary_profiles
          WHERE company_id=$1::bigint AND employee_id=e.id AND effective_from <= $2::date
          ORDER BY effective_from DESC,id DESC LIMIT 1
        ) s ON TRUE
        WHERE e.company_id=$1::bigint AND e.status='active' AND e.deleted_at IS NULL
          AND ($3::bigint[] IS NULL OR e.id=ANY($3::bigint[]))
        ORDER BY e.first_name,e.last_name,e.id`,[companyId,cutoff,sampleIds]);
      if(!matchesSampleRoster(employees.rows as EffectiveSalaryRow[],sampleIds)) {
        await client.query("ROLLBACK"); started=false;
        res.status(409).json({message:"Sampel harus berisi karyawan aktif yang tepat. Tidak ada data diubah."}); return;
      }
      const deductions = await client.query(`SELECT DISTINCT ON (d.employee_id,d.code)
        d.employee_id AS "employeeId",d.code,d.amount::text AS amount,d.effective_from::text AS "effectiveFrom",d.notes
        FROM public.payroll_deduction_settings d
        JOIN public.employees e ON e.id=d.employee_id AND e.company_id=$1::bigint
        WHERE d.company_id=$1::bigint AND d.effective_from <= $2::date
        AND e.status='active' AND e.deleted_at IS NULL
        AND ($3::bigint[] IS NULL OR e.id=ANY($3::bigint[]))
        ORDER BY d.employee_id,d.code,d.effective_from DESC,d.id DESC`,[companyId,cutoff,sampleIds]);
      const sources=await loadAutoKasbonSources(
        async(sql,args)=>client!.query(sql,args),companyId,sampleIds??undefined);
      const auto=overlayAutomaticKasbon(
        employees.rows as EffectiveSalaryRow[],deductions.rows as EffectiveDeductionRow[],
        sources.advances,sources.plans,sources.reservations,
        companyId,runId,Number(year),Number(month));
      const preview=finalizeAutomaticKasbonPreview(
        buildEffectiveSetupPreview(
          employees.rows as EffectiveSalaryRow[],auto.deductions,Number(year),Number(month)),
        auto);
      if (setupDigest(preview) !== digest) {
        await client.query("ROLLBACK"); started = false;
        res.status(409).json({ message: "Konfigurasi telah berubah. Muat ulang pratinjau sebelum menerapkan." }); return;
      }
      if (!preview.employeeCount || preview.missingSalaryCount || preview.missingDeductionConfigCount || preview.invalidCount ||
        preview.rows.some(row => row.net === null || row.deductions.kasbon_deduction === null)) {
        await client.query("ROLLBACK"); started = false;
        res.status(409).json({ message: "Gaji atau potongan belum lengkap, atau nominal potongan melebihi gaji kotor. Periksa konfigurasi sebelum menerapkan." }); return;
      }
      let added = 0;
      const autoPeriod=`${Number(year)}-${String(Number(month)).padStart(2,"0")}-01`;
      for (const row of preview.rows) {
        if (!row.baseSalary || !row.allowance || !row.gross || !row.net || !row.totalDeductions) throw new Error("INVALID_PREVIEW_ROW");
        const inserted = await client.query(`INSERT INTO public.payroll_items
          (run_id,employee_id,base_salary,allowance,gross_salary,bpjs_jht_employee,bpjs_kes_employee,
           pph21,other_deductions,kasbon_deduction,total_deductions,net_salary)
          SELECT $1::bigint,e.id,$3::numeric,$4::numeric,$5::numeric,$6::numeric,$7::numeric,
                 $8::numeric,$9::numeric,$10::numeric,$11::numeric,$12::numeric
          FROM public.employees e
          WHERE e.id=$2::bigint AND e.company_id=$13::bigint AND e.status='active' AND e.deleted_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM public.payroll_items i WHERE i.run_id=$1::bigint AND i.employee_id=e.id)
          RETURNING id`, [runId,row.employeeId,row.baseSalary,row.allowance,row.gross,
          row.deductions.bpjs_jht_employee,row.deductions.bpjs_kes_employee,row.deductions.pph21,
          row.deductions.other_deductions,row.deductions.kasbon_deduction,row.totalDeductions,row.net,companyId]);
        const allocations=auto.allocations.get(row.employeeId)??[];
        if((inserted.rowCount??0)===1 && allocations.length>0){
          const itemId=Number(inserted.rows[0].id);
          if(!Number.isSafeInteger(itemId)||itemId<1)throw new Error("INVALID_KASBON_ITEM_ID");
          for(const allocation of allocations){
            const saved=await client.query(`INSERT INTO public.payroll_kasbon_auto_reservations
              (company_id,employee_id,run_id,payroll_item_id,advance_id,period,amount,balance_at_preparation)
              VALUES ($1,$2,$3,$4,$5,$6::date,$7::numeric,$8::numeric)
              RETURNING id`,
              [companyId,row.employeeId,runId,itemId,allocation.advanceId,
               autoPeriod,allocation.amount,allocation.balance]);
            if(saved.rowCount!==1)throw new Error("KASBON_RESERVATION_NOT_SAVED");
          }
        }else if((inserted.rowCount??0)===0 && allocations.length>0){
          // Idempotent retry: all existing advance allocations must already match this run and item.
          const checked=await client.query(`SELECT r.advance_id AS "advanceId",r.amount::text AS amount,
                r.balance_at_preparation::text AS balance
             FROM public.payroll_kasbon_auto_reservations r
             JOIN public.payroll_items i ON i.id=r.payroll_item_id AND i.run_id=$1
              AND i.employee_id=$2
             WHERE r.company_id=$3 AND r.run_id=$1 AND r.employee_id=$2
              AND r.state='prepared'
             ORDER BY r.advance_id`,[runId,row.employeeId,companyId]);
          if(JSON.stringify(checked.rows.map((x:{advanceId:number;amount:string;balance:string})=>({
            advanceId:Number(x.advanceId),amount:x.amount,balance:x.balance
          })))!==JSON.stringify([...allocations].sort((a,b)=>a.advanceId-b.advanceId)))
            throw new Error("KASBON_EXISTING_ITEM_RESERVATION_MISMATCH");
        }
        added += inserted.rowCount ?? 0;
      }
      await client.query("COMMIT"); started = false;
      res.setHeader("Cache-Control", "no-store");
      res.json({ companyId,runId,added,skipped:preview.employeeCount-added,readyForPayment:false,
        sampleScope:sampleIds!==null,sampleEmployeeIds:sampleIds,
        message:"Gaji, tunjangan, kasbon otomatis terverifikasi, dan potongan diterapkan hanya pada karyawan yang belum ada di Draft. Tidak ada transaksi kasbon atau pembayaran dibuat." });
    } catch (error) {
      if (started && client) try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      req.log?.error?.({error,companyId,runId},"Payroll setup apply failed");
      res.status(503).json({message:"Penerapan struktur gaji gagal; transaksi dibatalkan."});
    } finally { client?.release(); }
  });

  router.get("/payroll/runs/:id/setup-preview", async (req: ScopedRequest, res: Response): Promise<void> => {
    if (!isDevelopmentEnvironment() && req.payrollActor?.role?.toLowerCase() !== "super_admin") {
      res.status(403).json({message:"Hanya Super Admin dapat memeriksa struktur gaji Payroll PROD."});return;
    }
    if (!effectiveSetupReadReady()) {
      res.status(503).json({ message: "Pratinjau konfigurasi memerlukan koneksi Payroll khusus." }); return;
    }
    const runId = positiveId(req.params.id);
    if (runId === null) {
      res.status(400).json({ message: "ID periode Payroll tidak valid." }); return;
    }
    const companyId = req.payrollCompanyId!;
    try {
      const run = await payrollScopedQuery(companyId,
        "SELECT id, month, year, status FROM public.payroll_runs WHERE company_id = $1 AND id = $2 LIMIT 1",
        [companyId, runId]);
      if (run.rowCount !== 1) {
        res.status(404).json({ message: "Periode bukan milik perusahaan aktif." }); return;
      }
      const { year, month, status } = run.rows[0];
      if (status !== "draft") {
        res.status(409).json({ message: "Konfigurasi hanya bisa dipratinjau untuk periode Draft." }); return;
      }
      let sampleIds: number[] | null;
      try { sampleIds=parseSampleEmployeeIds(req.query.sampleEmployeeIds,Number(year),Number(month)); }
      catch(error) {
        res.status(400).json({message:error instanceof Error?error.message:"INVALID_SAMPLE_SCOPE"}); return;
      }
      const effectiveThrough = periodEnd(Number(year), Number(month));
      const employeeResult = await payrollScopedQuery(companyId,
        `SELECT e.id AS "employeeId",e.first_name AS "firstName",e.last_name AS "lastName",
                p.base_salary::text AS "baseSalary",p.allowance::text AS "allowance",
                p.effective_from::text AS "salaryEffectiveFrom"
           FROM public.employees e
           LEFT JOIN LATERAL (
             SELECT s.base_salary,s.allowance,s.effective_from
               FROM public.payroll_salary_profiles s
              WHERE s.company_id=$1::bigint AND s.employee_id=e.id
                AND s.effective_from <= $2::date
              ORDER BY s.effective_from DESC,s.id DESC
              LIMIT 1
           ) p ON TRUE
          WHERE e.company_id=$1::bigint AND e.status='active' AND e.deleted_at IS NULL
            AND ($3::bigint[] IS NULL OR e.id=ANY($3::bigint[]))
          ORDER BY e.first_name,e.last_name,e.id`,
        [companyId, effectiveThrough,sampleIds]);
      if(!matchesSampleRoster(employeeResult.rows as EffectiveSalaryRow[],sampleIds)) {
        res.status(409).json({message:"Sampel harus berisi karyawan aktif yang tepat."}); return;
      }
      const deductionResult = await payrollScopedQuery(companyId,
        `SELECT DISTINCT ON (d.employee_id,d.code)
                d.employee_id AS "employeeId",d.code,d.amount::text AS amount,
                d.effective_from::text AS "effectiveFrom",d.notes
           FROM public.payroll_deduction_settings d
           JOIN public.employees e ON e.id=d.employee_id AND e.company_id=$1::bigint
          WHERE d.company_id=$1::bigint AND d.effective_from <= $2::date
            AND e.status='active' AND e.deleted_at IS NULL
            AND ($3::bigint[] IS NULL OR e.id=ANY($3::bigint[]))
          ORDER BY d.employee_id,d.code,d.effective_from DESC,d.id DESC`,
        [companyId, effectiveThrough,sampleIds]);
      const sources=await loadAutoKasbonSources(
        async(sql,args)=>payrollScopedQuery(companyId,sql,args),companyId,sampleIds??undefined);
      const auto=overlayAutomaticKasbon(
        employeeResult.rows as EffectiveSalaryRow[],
        deductionResult.rows as EffectiveDeductionRow[],
        sources.advances,sources.plans,sources.reservations,
        companyId,runId,Number(year),Number(month));
      const result=finalizeAutomaticKasbonPreview(
        buildEffectiveSetupPreview(
          employeeResult.rows as EffectiveSalaryRow[],auto.deductions,
          Number(year),Number(month)),
        auto);
      res.setHeader("Cache-Control", "no-store");
      res.json({ companyId, runId, year: Number(year), month: Number(month),
        sampleScope:sampleIds!==null,sampleEmployeeIds:sampleIds,...result,digest:setupDigest(result) });
    } catch (error) {
      req.log?.error?.({ error, companyId, runId }, "Payroll effective setup preview failed");
      res.status(503).json({ message: "Pratinjau konfigurasi gaji tidak dapat dihitung. Tidak ada data yang diubah." });
    }
  });
}
