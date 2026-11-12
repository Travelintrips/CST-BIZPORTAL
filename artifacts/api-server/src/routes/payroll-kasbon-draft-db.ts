import type {KasbonAdvance} from "./payroll-kasbon-automatic";
import type {KasbonAutoPlanRow,KasbonAutoReservationRow} from "./payroll-kasbon-draft-overlay";

type Result={rows:Record<string,unknown>[]};
export type ScopedQuery=(sql:string,args:unknown[])=>Promise<Result>;
function id(raw:unknown):number{
  const n=Number(raw);
  if(!Number.isSafeInteger(n)||n<=0)throw Error("INVALID_KASBON_SOURCE_ID");
  return n;
}
function amount(raw:unknown):string {
  if(typeof raw!=="string"||!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(raw))
    throw Error("INVALID_KASBON_SOURCE_AMOUNT");
  return raw;
}
export async function loadAutoKasbonSources(
 query:ScopedQuery,companyId:number,employeeIds?:readonly number[],
):Promise<{
 advances:KasbonAdvance[];plans:KasbonAutoPlanRow[];
 reservations:KasbonAutoReservationRow[];
}> {
 if(!Number.isSafeInteger(companyId)||companyId<1)throw Error("INVALID_KASBON_COMPANY");
 const adv=await query(`SELECT a.id, a.company_id AS "companyId", a.employee_id AS "employeeId",
   a.type,a.status,a.lifecycle_status AS "lifecycleStatus",a.currency,
   a.amount::text AS amount,a.paid_amount::text AS "paidAmount",
   a.settled_amount::text AS "settledAmount",a.remaining_amount::text AS "remainingAmount",
   a.approved_at::text AS "approvedAt",a.approved_by AS "approvedBy",
   a.disbursed_at::text AS "disbursedAt",a.disbursed_by AS "disbursedBy",
   a.accounting_entry_id AS "accountingEntryId",a.posting_status AS "postingStatus",
   a.voided_at::text AS "voidedAt"
  FROM public.cash_advances a
  JOIN public.employees e ON e.id=a.employee_id AND e.company_id=$1
  WHERE a.company_id=$1 AND a.type='kasbon' AND e.status='active' AND e.deleted_at IS NULL
    AND ($2::bigint[] IS NULL OR e.id=ANY($2::bigint[]))
  ORDER BY a.id`,[companyId,employeeIds??null]);
 const plan=await query(`SELECT company_id AS "companyId",employee_id AS "employeeId",
    advance_id AS "advanceId",choice,installment_amount::text AS "installmentAmount",
    first_period::text AS "firstPeriod",updated_at::text AS "updatedAt"
   FROM public.payroll_kasbon_auto_plans WHERE company_id=$1
    AND ($2::bigint[] IS NULL OR employee_id=ANY($2::bigint[]))
   ORDER BY employee_id,advance_id`,[companyId,employeeIds??null]);
 const res=await query(`SELECT company_id AS "companyId",employee_id AS "employeeId",
    advance_id AS "advanceId",run_id AS "runId",period::text,
    amount::text AS amount,balance_at_preparation::text AS "balanceAtPreparation",
    state FROM public.payroll_kasbon_auto_reservations WHERE company_id=$1
    AND state IN ('prepared','confirmed')
    AND ($2::bigint[] IS NULL OR employee_id=ANY($2::bigint[]))
    ORDER BY employee_id,advance_id,period,run_id`,[companyId,employeeIds??null]);
 return {
  advances:adv.rows.map(r=>({
    id:id(r.id),companyId:id(r.companyId),employeeId:id(r.employeeId),
    type:String(r.type),status:String(r.status),
    lifecycleStatus:r.lifecycleStatus===null?null:String(r.lifecycleStatus),
    currency:r.currency===null?null:String(r.currency),
    amount:amount(r.amount),paidAmount:amount(r.paidAmount),
    settledAmount:amount(r.settledAmount),remainingAmount:amount(r.remainingAmount),
    approvedAt:r.approvedAt===null?null:String(r.approvedAt),
    approvedBy:r.approvedBy===null?null:String(r.approvedBy),
    disbursedAt:r.disbursedAt===null?null:String(r.disbursedAt),
    disbursedBy:r.disbursedBy===null?null:String(r.disbursedBy),
    accountingEntryId:r.accountingEntryId===null?null:id(r.accountingEntryId),
    postingStatus:r.postingStatus===null?null:String(r.postingStatus),
    voidedAt:r.voidedAt===null?null:String(r.voidedAt),
  })),
  plans:plan.rows.map(r=>({
    companyId:id(r.companyId),employeeId:id(r.employeeId),advanceId:id(r.advanceId),
    choice:r.choice as "FULL"|"INSTALLMENT",
    installmentAmount:r.installmentAmount===null?null:amount(r.installmentAmount),
    firstPeriod:String(r.firstPeriod),updatedAt:String(r.updatedAt),
  })),
  reservations:res.rows.map(r=>({
    companyId:id(r.companyId),employeeId:id(r.employeeId),advanceId:id(r.advanceId),
    runId:id(r.runId),period:String(r.period),
    amount:amount(r.amount),balanceAtPreparation:amount(r.balanceAtPreparation),
    state:r.state as "prepared"|"confirmed"|"cancelled",
  })),
 };
}
