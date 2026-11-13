import { type IRouter, type Request, type Response } from "express";
import { getPayrollPool, payrollDedicatedEnabled, payrollProdDedicatedRequired, payrollScopedQuery, setPayrollCompanyScope } from "./payroll-prod-db";
import { isDevelopmentEnvironment } from "./dev-auth";
import { isPayrollProdApprover } from "./payroll-prod-approver";
import {
  calculateKasbonAutoDeduction, payrollMonth, moneyToCents,
  type KasbonAdvance, type KasbonPlan,
} from "./payroll-kasbon-automatic";

type ScopedRequest=Request&{payrollCompanyId?:number;payrollActor?:{role:string}};
const privileged=(req:ScopedRequest)=>
  ["admin","owner","super_admin"].includes(req.payrollActor?.role?.toLowerCase()??"");
function positiveId(raw:unknown):number|null {
  const n=Number(raw);
  return (typeof raw==="string"&&/^[1-9][0-9]*$/.test(raw)&&Number.isSafeInteger(n))?n:null;
}
const money=/^(0|[1-9][0-9]{0,12})(?:\.([0-9]{1,2}))?$/;
function parsePeriod(raw:unknown):string|null {
  if(typeof raw!=="string"||!/^20\d\d-(0[1-9]|1[0-2])-01$/.test(raw))return null;
  return raw;
}
type DbAdvance={
  id:number|string;companyId:number|string;employeeId:number|string;type:string;
  status:string;lifecycleStatus:string|null;currency:string|null;amount:string;
  paidAmount:string;settledAmount:string;remainingAmount:string;
  approvedAt:string|null;approvedBy:string|null;disbursedAt:string|null;disbursedBy:string|null;
  accountingEntryId:number|string|null;postingStatus:string|null;voidedAt:string|null;
};
function toAdvance(r:DbAdvance):KasbonAdvance {
  return {...r,id:Number(r.id),companyId:Number(r.companyId),employeeId:Number(r.employeeId),
    accountingEntryId:r.accountingEntryId===null?null:Number(r.accountingEntryId)};
}
type DbPlan={advanceId:number|string;choice:"FULL"|"INSTALLMENT";
  installmentAmount:string|null;firstPeriod:string;notes:string};
function toPlan(r:DbPlan):KasbonPlan {
  return {advanceId:Number(r.advanceId),choice:r.choice,
    installmentAmount:r.installmentAmount,firstPeriod:r.firstPeriod};
}
const advancesSql=`SELECT a.id,a.company_id AS "companyId",a.employee_id AS "employeeId",
 a.type,a.status,a.lifecycle_status AS "lifecycleStatus",a.currency,
 a.amount::text,a.paid_amount::text AS "paidAmount",
 a.settled_amount::text AS "settledAmount",a.remaining_amount::text AS "remainingAmount",
 a.approved_at::text AS "approvedAt",a.approved_by AS "approvedBy",
 a.disbursed_at::text AS "disbursedAt",a.disbursed_by AS "disbursedBy",
 a.accounting_entry_id AS "accountingEntryId",a.posting_status AS "postingStatus",
 a.voided_at::text AS "voidedAt"
 FROM public.cash_advances a WHERE a.company_id=$1 AND a.employee_id=$2
 AND a.type='kasbon' ORDER BY a.id`;
const plansSql=`SELECT advance_id AS "advanceId",choice,
 installment_amount::text AS "installmentAmount",first_period::text AS "firstPeriod",notes
 FROM public.payroll_kasbon_auto_plans
 WHERE company_id=$1 AND employee_id=$2 ORDER BY advance_id`;
function automaticReadReady():boolean {
  return isDevelopmentEnvironment()?payrollDedicatedEnabled():payrollProdDedicatedRequired();
}
function automaticReadAllowed(req:ScopedRequest):boolean {
  return isDevelopmentEnvironment()?privileged(req):isPayrollProdApprover(req.payrollActor,req.payrollCompanyId);
}
function automaticWriteEnabled(req:ScopedRequest):boolean {
  if(isDevelopmentEnvironment()) return payrollDedicatedEnabled() &&
    (process.env.PAYROLL_DEV_KASBON_AUTO_WRITE_ENABLED==="true" ||
     process.env.PAYROLL_DEV_SETUP_WRITE_ENABLED==="true") && privileged(req);
  return payrollProdDedicatedRequired() &&
    process.env.PAYROLL_PROD_KASBON_AUTO_WRITE_ENABLED==="true" &&
    isPayrollProdApprover(req.payrollActor,req.payrollCompanyId);
}
function unavailable(res:Response,write=false){
  res.status(write?501:503).json({message:"Kasbon otomatis memerlukan koneksi Payroll khusus dan feature flag yang sesuai."});
}
export function registerPayrollKasbonAutoRoutes(router:IRouter):void {
  router.get("/payroll/kasbon/employee/:employeeId",async(req:ScopedRequest,res:Response):Promise<void>=>{
    if(!automaticReadReady())return unavailable(res);
    if(!automaticReadAllowed(req)){res.status(403).json({message:"Akses kasbon Payroll ditolak."});return;}
    const employeeId=positiveId(req.params.employeeId);
    const year=Number(req.query.year),month=Number(req.query.month);
    if(!employeeId||!Number.isInteger(year)||!Number.isInteger(month)||year<2020||year>2100||month<1||month>12){
      res.status(400).json({message:"Karyawan atau periode tidak valid."});return;
    }
    const companyId=req.payrollCompanyId!;
    try {
      const emp=await payrollScopedQuery(companyId,
        "SELECT id FROM public.employees WHERE id=$1 AND company_id=$2 AND status='active' AND deleted_at IS NULL",
        [employeeId,companyId]);
      if(emp.rowCount!==1){res.status(404).json({message:"Karyawan aktif tidak ditemukan."});return;}
      const [advanceRows,planRows]=await Promise.all([
        payrollScopedQuery(companyId,advancesSql,[companyId,employeeId]),
        payrollScopedQuery(companyId,plansSql,[companyId,employeeId]),
      ]);
      const advances=advanceRows.rows.map(r=>toAdvance(r as DbAdvance));
      const plans=(planRows.rows as DbPlan[]).map(toPlan);
      const reservationRows=await payrollScopedQuery(companyId,`
        SELECT advance_id AS "advanceId",period::text AS period,amount::text AS amount,
               state,run_id AS "runId"
        FROM public.payroll_kasbon_auto_reservations
        WHERE company_id=$1 AND employee_id=$2 AND state IN ('prepared','confirmed')
        ORDER BY advance_id,period,run_id`,[companyId,employeeId]);
      const reservations=(reservationRows.rows as Array<{
        advanceId:number|string;period:string;amount:string;state:"prepared"|"confirmed";runId:number|string
      }>).map(r=>({advanceId:Number(r.advanceId),period:r.period,amount:r.amount,state:r.state}));
      const projection=calculateKasbonAutoDeduction(
        advances,plans,reservations,companyId,employeeId,year,month);
      const currentMonth=`${year}-${String(month).padStart(2,"0")}-01`;
      const heldHere=reservations.some(r=>r.period===currentMonth);
      const preview=heldHere?{...projection,total:null,canApply:false,
        rows:projection.rows.map(row=>({
          ...row,proposed:null,
          issue:row.issue??"KASBON_SUDAH_DI_DRAFT_ATU_DIKONFIRMASI"
        }))}:projection;
      const chosen=new Map((planRows.rows as DbPlan[]).map(r=>[Number(r.advanceId),r]));
      const safeAdvances=advances.map(a=>({
        advanceId:a.id,choice:chosen.get(a.id)?.choice??null,
        installmentAmount:chosen.get(a.id)?.installmentAmount??null,
        firstPeriod:chosen.get(a.id)?.firstPeriod??null,
        planLocked:reservations.some(r=>r.advanceId===a.id &&
          (r.state==="prepared"||r.state==="confirmed")),
        status:a.status,lifecycleStatus:a.lifecycleStatus,
        remainingAmount:a.remainingAmount,
        approvedAt:a.approvedAt,approvedBy:a.approvedBy,
        disbursedAt:a.disbursedAt,disbursedBy:a.disbursedBy,
        accountingEntryId:a.accountingEntryId,postingStatus:a.postingStatus,
        voidedAt:a.voidedAt,
        planNotes:chosen.get(a.id)?.notes??"",
      }));
      res.setHeader("Cache-Control","no-store");
      res.json({companyId,employeeId,year,month,advances:safeAdvances,preview,canEdit:automaticWriteEnabled(req),
        isAutomaticPreview:true,persistedDeduction:false,settledCashAdvance:false,canPost:false,canPay:false});
    }catch(e){
      req.log?.error?.({e,companyId,employeeId},"Payroll kasbon projection failed");
      res.status(503).json({message:"Data kasbon Payroll belum siap; tidak ada perubahan dilakukan."});
    }
  });

  router.put("/payroll/kasbon/plans/:advanceId",async(req:ScopedRequest,res:Response):Promise<void>=>{
    if(!automaticWriteEnabled(req)) {
      const configured=isDevelopmentEnvironment()
        ? payrollDedicatedEnabled() && (process.env.PAYROLL_DEV_KASBON_AUTO_WRITE_ENABLED==="true" ||
          process.env.PAYROLL_DEV_SETUP_WRITE_ENABLED==="true")
        : payrollProdDedicatedRequired() && process.env.PAYROLL_PROD_KASBON_AUTO_WRITE_ENABLED==="true";
      res.status(configured?403:501).json({message:"Pengaturan Kasbon Penuh/Cicilan belum diaktifkan atau pengguna tidak berwenang."});return;
    }
    const advanceId=positiveId(req.params.advanceId);
    const input=req.body;
    const employeeId=positiveId(String(input?.employeeId??""));
    const choice=input?.choice,firstPeriod=parsePeriod(input?.firstPeriod),
      installmentAmount=input?.installmentAmount??null,notes=input?.notes;
    if(!advanceId||!employeeId||!firstPeriod||!["FULL","INSTALLMENT"].includes(choice)||
       typeof notes!=="string"||notes.trim().length<5||notes.length>500||
       (choice==="FULL"&&installmentAmount!==null)||
       (choice==="INSTALLMENT"&&(typeof installmentAmount!=="string"||
         !money.test(installmentAmount)||moneyToCents(installmentAmount)<=0n))){
      res.status(400).json({message:"Pilih Penuh/Cicilan, nominal cicilan, bulan mulai, dan catatan persetujuan."});return;
    }
    const companyId=req.payrollCompanyId!;
    let client,started=false;
    try {
      client=await getPayrollPool().connect();
      await client.query("BEGIN");started=true;
      await setPayrollCompanyScope(client,companyId);
      await client.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)",[companyId,-100000001]);
      await client.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)",[companyId,advanceId]);
      // No editing an automatic deduction after a Draft has reserved it.
      const held=await client.query(`SELECT 1 FROM public.payroll_kasbon_auto_reservations
        WHERE company_id=$1 AND advance_id=$2 AND state IN ('prepared','confirmed') LIMIT 1`,
        [companyId,advanceId]);
      if(held.rowCount){
        await client.query("ROLLBACK");started=false;
        res.status(409).json({message:"Kasbon sudah masuk Draft Payroll atau dikonfirmasi. Pilihan dikunci agar tidak terjadi potongan ganda."});return;
      }
      const active=await client.query(
        "SELECT id FROM public.employees WHERE id=$1 AND company_id=$2 AND status='active' AND deleted_at IS NULL",
        [employeeId,companyId]);
      if(active.rowCount!==1){
        await client.query("ROLLBACK");started=false;res.status(404).json({message:"Karyawan tidak aktif."});return;
      }
      const a=await client.query(advancesSql.replace("ORDER BY a.id","AND a.id=$3 ORDER BY a.id"),
        [companyId,employeeId,advanceId]);
      if(a.rowCount!==1){
        await client.query("ROLLBACK");started=false;res.status(404).json({message:"Kasbon karyawan tidak ditemukan."});return;
      }
      // Check eligibility and amount using same source-of-truth calculation.
      const adv=toAdvance(a.rows[0] as DbAdvance);
      const proposal=calculateKasbonAutoDeduction([adv],
        [{advanceId,choice,firstPeriod,installmentAmount}],[],companyId,employeeId,
        Number(firstPeriod.slice(0,4)),Number(firstPeriod.slice(5,7)));
      if(!proposal.canApply||proposal.rows.length!==1){
        await client.query("ROLLBACK");started=false;
        res.status(409).json({message:"Kasbon belum sah atau sudah lunas. Rencana tidak disimpan."});return;
      }
      const written=await client.query(`INSERT INTO public.payroll_kasbon_auto_plans
        (company_id,employee_id,advance_id,choice,installment_amount,first_period,notes)
        VALUES ($1,$2,$3,$4,$5::numeric,$6::date,$7)
        ON CONFLICT(company_id,advance_id) DO UPDATE SET
          choice=EXCLUDED.choice,installment_amount=EXCLUDED.installment_amount,
          first_period=EXCLUDED.first_period,notes=EXCLUDED.notes,updated_at=now()
        WHERE payroll_kasbon_auto_plans.employee_id=EXCLUDED.employee_id
        RETURNING id`,
        [companyId,employeeId,advanceId,choice,installmentAmount,firstPeriod,notes.trim()]);
      if(written.rowCount!==1)throw new Error("PLAN_CHANGE_CONFLICT");
      await client.query("COMMIT");started=false;
      res.setHeader("Cache-Control","no-store");
      res.json({companyId,employeeId,advanceId,choice,
        installmentAmount:choice==="INSTALLMENT"?installmentAmount:null,
        firstPeriod,estimatedCurrentDeduction:proposal.total,
        automatic:true,appliedToPayroll:false,settledCashAdvance:false});
    }catch(e){
      if(started&&client)try{await client.query("ROLLBACK")}catch{}
      req.log?.error?.({e,companyId,advanceId},"Payroll kasbon plan save failed");
      res.status(503).json({message:"Pilihan kasbon gagal disimpan; seluruh perubahan dibatalkan."});
    }finally{client?.release();}
  });
}
