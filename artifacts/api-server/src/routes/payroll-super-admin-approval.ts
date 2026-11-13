import { PAYROLL_SUPER_ADMIN_APPROVAL_MARKER, payrollSuperAdminApprovalDigest } from "./payroll-super-admin-approval-receipt";
import type { IRouter, Request, Response } from "express";
import type { PayrollDbClient } from "@workspace/db";
import { getPayrollPool, payrollDedicatedEnabled, payrollProdDedicatedRequired, payrollReadOnlyReady, payrollScopedQuery, setPayrollCompanyScope } from "./payroll-prod-db";
import { isDevelopmentEnvironment } from "./dev-auth";
import { buildPayrollPreview, type PayrollPreviewItem } from "./payroll-preview";
import { verifyKasbonReviewLedger } from "./payroll-kasbon-hr-review-guard";

/**
 * One approval by an authenticated Super Admin, with a durable receipt in the
 * existing payroll_runs.notes + approved_at fields. There is deliberately no
 * dependency on HR/accounting approval tables and no journal/payment write.
 */
type ScopedRequest = Request & {
  payrollCompanyId?: number;
  payrollActor?: { id?: number | string; email?: string; role: string };
};
type Query = (sql: string, values: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
type ItemRow = {
  id: number | string; employee_id: number | string; is_paid: boolean;
  base_salary: unknown; allowance: unknown; gross_salary: unknown;
  bpjs_jht_employee: unknown; bpjs_kes_employee: unknown; pph21: unknown;
  other_deductions: unknown; kasbon_deduction: unknown;
  total_deductions: unknown; net_salary: unknown;
};

const validId = (raw: unknown): number | null =>
  typeof raw === "string" && /^[1-9][0-9]*$/.test(raw) &&
  Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
const actorAllowed = (req: ScopedRequest): boolean =>
  req.payrollActor?.role?.trim().toLowerCase() === "super_admin" &&
  Boolean(String(req.payrollActor?.id ?? "").trim()) &&
  Boolean(String(req.payrollActor?.email ?? "").trim());
const enabled = (): boolean => isDevelopmentEnvironment()
  ? payrollDedicatedEnabled() && process.env.PAYROLL_DEV_SUPER_ADMIN_APPROVAL_ENABLED === "true"
  : payrollProdDedicatedRequired() && process.env.PAYROLL_PROD_SUPER_ADMIN_APPROVAL_ENABLED === "true";
const approvalReadReady = (): boolean =>
  isDevelopmentEnvironment() ? payrollDedicatedEnabled() : payrollReadOnlyReady();

const itemSQL = `SELECT pi.id, pi.employee_id, pi.base_salary::text,
 pi.allowance::text, pi.gross_salary::text, pi.bpjs_jht_employee::text,
 pi.bpjs_kes_employee::text, pi.pph21::text, pi.other_deductions::text,
 pi.kasbon_deduction::text, pi.total_deductions::text, pi.net_salary::text,
 pi.is_paid
 FROM public.payroll_items pi
 JOIN public.employees e ON e.id=pi.employee_id AND e.company_id=$1
   AND e.status='active' AND e.deleted_at IS NULL
 WHERE pi.run_id=$2 ORDER BY pi.id`;

async function inspect(query: Query, companyId: number, runId: number) {
  const [active, items, allItems] = await Promise.all([
    query("SELECT count(*)::integer AS total FROM public.employees WHERE company_id=$1 AND status='active' AND deleted_at IS NULL", [companyId]),
    query(itemSQL,[companyId,runId]),
    query("SELECT count(*)::integer AS total FROM public.payroll_items WHERE run_id=$1",[runId]),
  ]);
  const rows = items.rows as ItemRow[];
  const ids = rows.map(r => Number(r.employee_id));
  const normalized: PayrollPreviewItem[] = rows.map(r => ({
    id:Number(r.id),employeeId:Number(r.employee_id),
    baseSalary:String(r.base_salary),allowance:String(r.allowance),
    grossSalary:String(r.gross_salary),bpjsJhtEmployee:String(r.bpjs_jht_employee),
    bpjsKesEmployee:String(r.bpjs_kes_employee),pph21:String(r.pph21),
    otherDeductions:String(r.other_deductions),kasbonDeduction:String(r.kasbon_deduction),
    totalDeductions:String(r.total_deductions),netSalary:String(r.net_salary),
  }));
  const preview=buildPayrollPreview(normalized);
  const coverage = rows.length > 0 &&
    rows.length === Number(active.rows[0]?.total ?? 0) &&
    rows.length === Number(allItems.rows[0]?.total ?? 0) &&
    new Set(ids).size === rows.length &&
    ids.every(id => Number.isSafeInteger(id) && id > 0);
  const allUnpaid = rows.every(r=>r.is_paid === false && Number(r.base_salary) > 0);
  const kasbonVerified=await verifyKasbonReviewLedger(
    async(sql,args)=>query(sql,args),companyId,runId,rows,
  );
  const digest=payrollSuperAdminApprovalDigest(companyId,runId,normalized);
  return {
    ...preview,digest,fullCoverage:coverage,allUnpaid,
    kasbonVerified,canApproveData:coverage && allUnpaid &&
      kasbonVerified && preview.mismatchedItemIds.length === 0,
  };
}

export function registerPayrollSuperAdminApprovalRoutes(router: IRouter): void {
  router.get("/payroll/runs/:id/super-admin-approval-preview",
    async(req: ScopedRequest,res:Response):Promise<void>=>{
      if(!approvalReadReady()){
        res.status(503).json({message:"Pratinjau persetujuan memerlukan koneksi database Payroll khusus."});return;
      }
      if(!actorAllowed(req)){res.status(403).json({message:"Hanya Super Admin dapat menyetujui Payroll."});return;}
      const runId=validId(req.params.id),companyId=req.payrollCompanyId;
      if(!runId||!companyId){res.status(400).json({message:"Periode Payroll tidak valid."});return;}
      try{
        const run=await payrollScopedQuery(companyId,
          "SELECT status,posting_status,accounting_entry_id,payment_entry_id,approved_at,notes FROM public.payroll_runs WHERE company_id=$1 AND id=$2",
          [companyId,runId]);
        if(run.rowCount!==1){res.status(404).json({message:"Periode Payroll tidak ditemukan."});return;}
        const current=run.rows[0];
        const data=await inspect(async(sql,args)=>payrollScopedQuery(companyId,sql,args),companyId,runId);
        const cleanDraft=current.status==="draft" && current.posting_status==="pending" &&
          current.accounting_entry_id==null && current.payment_entry_id==null &&
          current.approved_at==null && !String(current.notes??"").includes(PAYROLL_SUPER_ADMIN_APPROVAL_MARKER);
        const blockedReasons:string[]=[];
        if(!cleanDraft)blockedReasons.push("RUN_NOT_CLEAN_DRAFT");
        if(!data.fullCoverage)blockedReasons.push("ACTIVE_EMPLOYEE_COVERAGE_INCOMPLETE");
        if(!data.allUnpaid)blockedReasons.push("PAID_OR_INVALID_ITEM");
        if(data.mismatchedItemIds.length)blockedReasons.push("PAYROLL_TOTALS_MISMATCH");
        if(!data.kasbonVerified)blockedReasons.push("KASBON_RESERVATIONS_INVALID");
        if(!enabled())blockedReasons.push("SUPER_ADMIN_APPROVAL_DISABLED");
        res.setHeader("Cache-Control","no-store");
        res.json({companyId,runId,status:current.status,approvedAt:current.approved_at??null,
          canApprove:blockedReasons.length===0,blockedReasons,
          itemCount:data.itemCount,gross:data.gross,deductions:data.deductions,net:data.net,
          digest:data.digest,fullCoverage:data.fullCoverage,kasbonReservationVerified:data.kasbonVerified,
          readyForPayment:false,accountingPosted:false});
      }catch(error){
        req.log?.error?.({error,companyId,runId},"Super Admin Payroll approval preview failed");
        res.status(503).json({message:"Pratinjau persetujuan Payroll gagal."});
      }
    });

  router.post("/payroll/runs/:id/super-admin-approve",
    async(req: ScopedRequest,res:Response):Promise<void>=>{
      if(!enabled()){
        res.status(501).json({message:"Persetujuan Super Admin Payroll belum diaktifkan untuk lingkungan ini."});return;
      }
      if(!actorAllowed(req)){res.status(403).json({message:"Hanya Super Admin dapat menyetujui Payroll."});return;}
      const runId=validId(req.params.id),companyId=req.payrollCompanyId;
      const note=typeof req.body?.note==="string"?req.body.note.trim():"";
      const digest=req.body?.expectedDigest;
      if(!runId||!companyId||req.body?.confirm!==true ||
        typeof digest!=="string"||!/^[0-9a-f]{64}$/.test(digest)||
        note.length<10||note.length>500){
        res.status(400).json({message:"Konfirmasi, catatan, dan sidik data Payroll wajib valid."});return;
      }
      const actorId=String(req.payrollActor?.id??"").trim();
      const actorEmail=String(req.payrollActor?.email??"").trim().toLowerCase();
      let client:PayrollDbClient|undefined,started=false;
      try{
        client=await getPayrollPool().connect();
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");started=true;
        await setPayrollCompanyScope(client,companyId);
        await client.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)",[companyId,-runId]);
        const run=await client.query(
          "SELECT status,posting_status,accounting_entry_id,payment_entry_id,approved_at,notes FROM public.payroll_runs WHERE company_id=$1 AND id=$2 FOR UPDATE",
          [companyId,runId],
        );
        if(run.rowCount!==1){await client.query("ROLLBACK");started=false;res.status(404).json({message:"Periode tidak ditemukan."});return;}
        const current=run.rows[0];
        const cleanDraft=current.status==="draft"&&current.posting_status==="pending"&&
          current.accounting_entry_id==null&&current.payment_entry_id==null&&
          current.approved_at==null&&!String(current.notes??"").includes(PAYROLL_SUPER_ADMIN_APPROVAL_MARKER);
        if(!cleanDraft){await client.query("ROLLBACK");started=false;res.status(409).json({message:"Payroll sudah disetujui atau bukan Draft bersih."});return;}
        const snapshot=await inspect(async(sql,args)=>client!.query(sql,args),companyId,runId);
        if(!snapshot.canApproveData||snapshot.digest!==digest){
          await client.query("ROLLBACK");started=false;
          res.status(409).json({message:"Data Payroll berubah, belum lengkap, atau reservasi kasbon tidak cocok."});return;
        }
        const receipt=PAYROLL_SUPER_ADMIN_APPROVAL_MARKER+" "+JSON.stringify({actorId,actorEmail,digest,note});
        const changed=await client.query(
          `UPDATE public.payroll_runs
              SET status='reviewed',approved_at=now(),
                  notes=concat_ws(E'\\n',nullif(notes,''),$3::text)
            WHERE company_id=$1 AND id=$2 AND status='draft'
              AND posting_status='pending' AND approved_at IS NULL
              AND accounting_entry_id IS NULL AND payment_entry_id IS NULL
          RETURNING id,status,approved_at,notes`,
          [companyId,runId,receipt],
        );
        if(changed.rowCount!==1||!String(changed.rows[0]?.notes??"").includes(receipt)||
          changed.rows[0]?.approved_at==null)throw Error("SUPER_ADMIN_APPROVAL_READBACK_FAILED");
        await client.query("COMMIT");started=false;
        res.setHeader("Cache-Control","no-store");
        res.json({companyId,runId,status:"reviewed",approvedBy:actorEmail,
          approvedAt:changed.rows[0].approved_at,digest,itemCount:snapshot.itemCount,
          gross:snapshot.gross,deductions:snapshot.deductions,net:snapshot.net,
          oneSuperAdminApproval:true,hrReviewRequired:false,accountingReviewRequired:false,
          readyForPayment:false,accountingPosted:false,paid:false});
      }catch(error){
        if(started&&client)try{await client.query("ROLLBACK");}catch{}
        req.log?.error?.({error,companyId,runId},"Super Admin Payroll approval rolled back");
        res.status(503).json({message:"Persetujuan gagal; transaksi dibatalkan tanpa jurnal atau pembayaran."});
      }finally{client?.release();}
    });
}
