import {moneyToCents} from "./payroll-kasbon-automatic";

type Item = {id:unknown;employee_id:unknown;kasbon_deduction:unknown};
type Reservation = {
 payrollItemId:unknown;employeeId:unknown;amount:unknown;heldBalance:unknown;currentBalance:unknown;
 advanceStatus:unknown;advanceLifecycle:unknown;advanceApprovedAt:unknown;advanceApprovedBy:unknown;
 advanceDisbursedAt:unknown;advanceDisbursedBy:unknown;advanceAccountingEntryId:unknown;
 advancePostingStatus:unknown;advanceVoidedAt:unknown;state:unknown;
};
type Query = (sql:string,params:unknown[])=>Promise<{rows:Reservation[]}>;
const id=(v:unknown)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<=0)throw Error("INVALID_KASBON_ID");return n;};
const cents=(v:unknown)=>{if(typeof v!=="string"||!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(v))throw Error("INVALID_KASBON_AMOUNT");return moneyToCents(v);};

/** Review only. No settlement, cash advance, payment or journal writes. */
export function kasbonReviewMatchesReservations(items:readonly Item[],holds:readonly Reservation[]):boolean {
 try {
  const expected=new Map<number,{employee:number;amount:bigint}>();
  for(const item of items){
   const key=id(item.id),employee=id(item.employee_id),amount=cents(item.kasbon_deduction);
   if(expected.has(key))return false;
   expected.set(key,{employee,amount});
  }
  const observed=new Map<number,bigint>();
  for(const hold of holds){
   const itemId=id(hold.payrollItemId),employee=id(hold.employeeId);
   const matching=expected.get(itemId);
   if(!matching||matching.employee!==employee||hold.state!=="prepared")return false;
   const amount=cents(hold.amount);
   if(amount<=0n||cents(hold.heldBalance)!==cents(hold.currentBalance))return false;
   if(["draft","repaid","void","rejected","cancelled"].includes(String(hold.advanceStatus).toLowerCase()) ||
      !["outstanding","partially_settled","disbursed"].includes(String(hold.advanceLifecycle).toLowerCase()))return false;
   const approved=hold.advanceApprovedAt!=null && Boolean(String(hold.advanceApprovedBy??"").trim());
   const disbursed=hold.advanceDisbursedAt!=null && Boolean(String(hold.advanceDisbursedBy??"").trim());
   const posted=Number.isSafeInteger(Number(hold.advanceAccountingEntryId)) &&
     Number(hold.advanceAccountingEntryId)>0 &&
     String(hold.advancePostingStatus??"").trim().toLowerCase()==="posted";
   if(!approved||!disbursed||!posted||hold.advanceVoidedAt!=null)return false;
   // The reservation schema already enforces one advance per run and non-negative held balances.
   observed.set(itemId,(observed.get(itemId)??0n)+amount);
  }
  for(const [key,value] of expected)if(value.amount!==(observed.get(key)??0n))return false;
  return true;
 }catch{return false;}
}
const sql=`SELECT r.payroll_item_id AS "payrollItemId",r.employee_id AS "employeeId",
 r.amount::text AS amount,r.balance_at_preparation::text AS "heldBalance",
 a.remaining_amount::text AS "currentBalance",a.status AS "advanceStatus",
 a.lifecycle_status AS "advanceLifecycle",a.approved_at AS "advanceApprovedAt",
 a.approved_by AS "advanceApprovedBy",a.disbursed_at AS "advanceDisbursedAt",
 a.disbursed_by AS "advanceDisbursedBy",a.accounting_entry_id AS "advanceAccountingEntryId",
 a.posting_status AS "advancePostingStatus",a.voided_at AS "advanceVoidedAt",r.state
 FROM public.payroll_kasbon_auto_reservations r
 LEFT JOIN public.cash_advances a ON a.id=r.advance_id AND a.company_id=r.company_id
  AND a.employee_id=r.employee_id AND a.type='kasbon'
 WHERE r.company_id=$1 AND r.run_id=$2 ORDER BY r.payroll_item_id,r.id`;
export async function verifyKasbonReviewLedger(
 query:Query,companyId:number,runId:number,items:readonly Item[],
):Promise<boolean>{
 // Query even for zero-valued deductions: manual edits must not conceal reserved loans.
 const result=await query(sql,[companyId,runId]);
 return kasbonReviewMatchesReservations(items,result.rows);
}
