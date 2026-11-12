/**
 * Standalone payroll kasbon deduction projection.
 * Pure calculation: NO bank reconciliation, cash-advance settlement, GL, payroll item
 * or database mutation. A proposal is not a paid/reconciled advance.
 */
export type KasbonChoice = "FULL" | "INSTALLMENT";
export type KasbonAdvance = {
  id: number;
  companyId: number;
  employeeId: number;
  type: string;
  status: string;
  lifecycleStatus: string | null;
  currency: string | null;
  amount: string;
  paidAmount: string;
  settledAmount: string;
  remainingAmount: string;
  approvedAt: string | null;
  approvedBy: string | null;
  disbursedAt: string | null;
  disbursedBy: string | null;
  accountingEntryId: number | null;
  postingStatus: string | null;
  voidedAt: string | null;
};
export type KasbonPlan = {
  advanceId: number;
  choice: KasbonChoice;
  installmentAmount: string | null;
  firstPeriod: string; // YYYY-MM-01
};
export type KasbonPrepared = {
  advanceId: number;
  period: string; // YYYY-MM-01
  amount: string;
  state: "prepared" | "confirmed" | "cancelled";
  balanceAtPreparation?: string | null;
};
const validMoney=/^(0|[1-9][0-9]{0,12})(?:\.([0-9]{1,2}))?$/;
export function moneyToCents(raw:string):bigint {
  if(typeof raw!=="string"||!validMoney.test(raw))throw Error("INVALID_KASBON_MONEY");
  const [w,f=""]=raw.split(".");
  return BigInt(w)*100n+BigInt(f.padEnd(2,"0"));
}
export function centsToMoney(value:bigint):string {
  if(value<0n)throw Error("NEGATIVE_KASBON_AMOUNT");
  return `${value/100n}.${(value%100n).toString().padStart(2,"0")}`;
}
export function payrollMonth(year:number,month:number):string {
  if(!Number.isSafeInteger(year)||year<2020||year>2100||
     !Number.isInteger(month)||month<1||month>12)throw Error("INVALID_PAYROLL_PERIOD");
  return `${year}-${String(month).padStart(2,"0")}-01`;
}
export function calculateKasbonAutoDeduction(
  advances: readonly KasbonAdvance[],plans:readonly KasbonPlan[],
  prepared:readonly KasbonPrepared[],companyId:number,employeeId:number,
  year:number,month:number,
) {
  if(!Number.isSafeInteger(companyId)||companyId<1||
     !Number.isSafeInteger(employeeId)||employeeId<1)throw Error("INVALID_SCOPE");
  const period=payrollMonth(year,month);
  const planByAdvance=new Map<number,KasbonPlan>();
  for(const p of plans) {
    if(!Number.isSafeInteger(p.advanceId)||p.advanceId<1||planByAdvance.has(p.advanceId)||
       !["FULL","INSTALLMENT"].includes(p.choice)||
       !/^20\d\d-(0[1-9]|1[0-2])-01$/.test(p.firstPeriod))throw Error("INVALID_KASBON_PLAN");
    if(p.choice==="FULL"&&p.installmentAmount!==null)throw Error("FULL_WITH_INSTALLMENT_AMOUNT");
    if(p.choice==="INSTALLMENT"&&(!p.installmentAmount||moneyToCents(p.installmentAmount)<=0n))
      throw Error("INVALID_KASBON_INSTALLMENT");
    planByAdvance.set(p.advanceId,p);
  }
  const seen=new Set<number>();
  const rows: Array<{
    advanceId:number;choice:KasbonChoice|null;balance:string;
    proposed:string|null;issue:string|null;existingPreparation:boolean
  }>=[];
  let total=0n,blocked=false;
  for(const a of advances) {
    if(!Number.isSafeInteger(a.id)||a.id<1||seen.has(a.id))throw Error("DUPLICATE_KASBON_ADVANCE");
    seen.add(a.id);
    if(a.companyId!==companyId||a.employeeId!==employeeId)throw Error("CROSS_COMPANY_KASBON");
    const balance=moneyToCents(a.remainingAmount);
    const amount=moneyToCents(a.amount);
    const paid=moneyToCents(a.paidAmount);
    const settled=moneyToCents(a.settledAmount);
    if(balance>amount||paid+settled>amount||balance!==amount-paid-settled)
      throw Error("KASBON_BALANCE_MISMATCH");
    if(a.type!=="kasbon"||!["IDR",null].includes(a.currency))
      throw Error("INVALID_KASBON_SOURCE");
    // Draft has an apparent positive remaining amount but MUST NOT be charged.
    const status=a.status.toLowerCase();
    const lifecycle=(a.lifecycleStatus??"").toLowerCase();
    const hasApproval=a.approvedAt!==null && Boolean(a.approvedBy?.trim());
    const hasDisbursement=a.disbursedAt!==null && Boolean(a.disbursedBy?.trim());
    const hasPostedAdvanceJournal=Number.isSafeInteger(a.accountingEntryId) &&
      (a.accountingEntryId??0)>0 && String(a.postingStatus??"").trim().toLowerCase()==="posted";
    const notVoided=a.voidedAt===null;
    const plan=planByAdvance.get(a.id);
    const eligible=balance>0n && !["draft","repaid","void","rejected","cancelled"].includes(status) &&
      ["outstanding","partially_settled","disbursed"].includes(lifecycle) &&
      hasApproval && hasDisbursement && hasPostedAdvanceJournal && notVoided;
    // A previously selected plan must not silently become Rp0 when its
    // positive-balance advance loses approval, disbursement, posting or status
    // eligibility before Draft materialization. A prepared/confirmed hold is
    // equally blocking until its source is reconciled.
    if(!eligible) {
      const activeHold=prepared.some(x=>x.advanceId===a.id &&
        (x.state==="prepared"||x.state==="confirmed"));
      if(balance>0n && (plan!==undefined || activeHold)) {
        rows.push({advanceId:a.id,choice:plan?.choice??null,balance:centsToMoney(balance),
          proposed:null,issue:"KASBON_PLAN_SOURCE_NOT_ELIGIBLE",
          existingPreparation:activeHold});
        blocked=true;
      }
      continue;
    }
    if(!plan) {
      rows.push({advanceId:a.id,choice:null,balance:centsToMoney(balance),proposed:null,
        issue:"PILIH_PENUH_ATAU_CICILAN",existingPreparation:false});
      blocked=true;continue;
    }
    if(plan.firstPeriod>period)continue;
    const other=prepared.filter(x=>x.advanceId===a.id && x.state==="prepared" && x.period!==period);
    if(other.length>0) {
      rows.push({advanceId:a.id,choice:plan.choice,balance:centsToMoney(balance),
        proposed:null,issue:"POTONGAN_PERIODE_LAIN_BELUM_DIKONFIRMASI",existingPreparation:false});
      blocked=true;continue;
    }
    const same=prepared.filter(x=>x.advanceId===a.id && x.period===period && x.state==="prepared");
    if(same.length>1)throw Error("DUPLICATE_KASBON_PREPARATION");
    const proposed=plan.choice==="FULL"?balance:
      (moneyToCents(plan.installmentAmount!)<balance?moneyToCents(plan.installmentAmount!):balance);
    if(same.length===1&&moneyToCents(same[0].amount)!==proposed) {
      rows.push({advanceId:a.id,choice:plan.choice,balance:centsToMoney(balance),
        proposed:null,issue:"PERUBAHAN_SETELAH_DRAFT_DISIAPKAN",existingPreparation:true});
      blocked=true;continue;
    }
    total+=proposed;
    rows.push({advanceId:a.id,choice:plan.choice,balance:centsToMoney(balance),
      proposed:centsToMoney(proposed),issue:null,existingPreparation:same.length===1});
  }
  if([...planByAdvance.keys()].some(id=>!seen.has(id)))throw Error("ORPHAN_KASBON_PLAN");
  if(prepared.some(x=>!seen.has(x.advanceId)))throw Error("ORPHAN_KASBON_PREPARATION");
  return {period,companyId,employeeId,rows,automaticallyCalculated:true as const,
    total:blocked?null:centsToMoney(total),canApply:!blocked&&rows.length>0,
    canSettle:false as const,canPost:false as const,canPay:false as const,
    note:"Potongan dihitung dari saldo kasbon BizPortal. Tidak melunasi saldo sebelum Payroll benar-benar diproses."};
}
