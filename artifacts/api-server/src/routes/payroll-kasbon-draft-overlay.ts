import {
  calculateKasbonAutoDeduction,centsToMoney,moneyToCents,payrollMonth,
  type KasbonAdvance,type KasbonPlan,type KasbonPrepared
} from "./payroll-kasbon-automatic";
import type {EffectiveSalaryRow,EffectiveDeductionRow} from "./payroll-setup-effective-preview";
import {buildEffectiveSetupPreview} from "./payroll-setup-effective-preview";

export type KasbonAutoPlanRow=KasbonPlan&{companyId:number;employeeId:number;updatedAt:string};
export type KasbonAutoReservationRow={
 companyId:number;employeeId:number;advanceId:number;runId:number;period:string;
 amount:string;balanceAtPreparation:string;state:"prepared"|"confirmed"|"cancelled";
};
export type KasbonDraftAllocation={advanceId:number;amount:string;balance:string};
export type KasbonAutoProjection={
 deductions:EffectiveDeductionRow[];
 allocations:Map<number,KasbonDraftAllocation[]>;
 issues:Map<number,string[]>;
 sourceRows:Map<number,Array<Record<string,string|number|null>>>;
};
export function overlayAutomaticKasbon(
 employees:readonly EffectiveSalaryRow[],manual:readonly EffectiveDeductionRow[],
 advances:readonly KasbonAdvance[],plans:readonly KasbonAutoPlanRow[],
 reservations:readonly KasbonAutoReservationRow[],companyId:number,runId:number,
 year:number,month:number,
):KasbonAutoProjection {
 if(!Number.isSafeInteger(companyId)||companyId<1||!Number.isSafeInteger(runId)||runId<1)
   throw Error("INVALID_KASBON_RUN_SCOPE");
 const period=payrollMonth(year,month);
 const ids=new Set(employees.map(e=>Number(e.employeeId)));
 if(ids.size!==employees.length||[...ids].some(id=>!Number.isSafeInteger(id)||id<=0))
   throw Error("INVALID_KASBON_EMPLOYEE_LIST");
 const byId=<T extends {employeeId:number}>(records:readonly T[])=>{
   const m=new Map<number,T[]>();
   for(const x of records){if(!ids.has(x.employeeId))throw Error("ORPHAN_KASBON_EMPLOYEE");
     m.set(x.employeeId,[...(m.get(x.employeeId)??[]),x]);}
   return m;
 };
 const adv=byId(advances),plan=byId(plans),reserv=byId(reservations);
 const issues=new Map<number,string[]>(),allocations=new Map<number,KasbonDraftAllocation[]>();
 const sourceRows=new Map<number,Array<Record<string,string|number|null>>>();
 const deductions=[...manual];
 for(const emp of employees){
   const employeeId=Number(emp.employeeId);
   const loans=adv.get(employeeId)??[],p=plan.get(employeeId)??[],rs=reserv.get(employeeId)??[];
   if(loans.length===0&&p.length===0&&rs.length===0)continue;
   if(loans.some(a=>a.companyId!==companyId||a.employeeId!==employeeId)||
     p.some(a=>a.companyId!==companyId||a.employeeId!==employeeId)||
     rs.some(a=>a.companyId!==companyId||a.employeeId!==employeeId))
     throw Error("CROSS_COMPANY_KASBON_PROJECTION");
   const prepared:KasbonPrepared[]=rs.map(r=>({
     advanceId:r.advanceId,period:r.period,amount:r.amount,
     state:r.state,balanceAtPreparation:r.balanceAtPreparation
   }));
   const projection=calculateKasbonAutoDeduction(loans,p,prepared,companyId,employeeId,year,month);
   const rowIssues=projection.rows.filter(x=>x.issue).map(x=>String(x.issue));
   const included=projection.rows.filter(x=>x.proposed!==null&&x.issue===null);
   const source=loans.map(a=>{
     const choice=p.find(x=>x.advanceId===a.id);
     const held=rs.filter(x=>x.advanceId===a.id).sort((a,b)=>a.period.localeCompare(b.period));
     return {advanceId:a.id,balance:a.remainingAmount,status:a.status,
       lifecycle:a.lifecycleStatus,planChoice:choice?.choice??null,
       planInstallment:choice?.installmentAmount??null,
       planStart:choice?.firstPeriod??null,planUpdatedAt:choice?.updatedAt??null,
       reservationPeriod:held.map(r=>r.period+":"+r.state+":"+r.amount).join("|")};
   });
   sourceRows.set(employeeId,source);
   for(const r of rs){
     if(r.state==="confirmed"&&r.period===period)
       rowIssues.push("KASBON_PERIODE_SUDAH_DIKONFIRMASI");
     if(r.state==="prepared"&&r.period===period&&r.runId!==runId)
       rowIssues.push("KASBON_SUDAH_DIPERSIAPKAN_RUN_LAIN");
   }
   // If the canonical advance balance or lifecycle changed after Draft
   // preparation, do not silently turn its reserved salary deduction into Rp0.
   for(const held of rs.filter(x=>x.state==="prepared")){
     if(!projection.rows.some(x=>x.advanceId===held.advanceId&&x.proposed!==null&&x.issue===null))
       rowIssues.push("RESERVASI_KASBON_SALDO_ATAU_STATUS_BERUBAH");
   }
   const eligible=projection.rows.length>0;
   const current=manual.find(d=>Number(d.employeeId)===employeeId&&d.code==="kasbon_deduction");
   if((eligible||p.length>0)&&current&&moneyToCents(current.amount)>0n)
     rowIssues.push("KASBON_MANUAL_DAN_OTOMATIS_BERSAMAAN");
   if(rowIssues.length)issues.set(employeeId,[...new Set(rowIssues)]);
   if(!eligible&&p.length===0)continue;
   const reserve:KasbonDraftAllocation[]=included.map(x=>({
     advanceId:x.advanceId,amount:String(x.proposed),balance:x.balance,
   })).filter(x=>moneyToCents(x.amount)>0n);
   allocations.set(employeeId,reserve);
   const total=projection.total??"0.00";
   const entry:EffectiveDeductionRow={
     employeeId,code:"kasbon_deduction",amount:total,effectiveFrom:period,
     notes:"Potongan kasbon otomatis BizPortal: "+reserve.map(x=>"#"+x.advanceId).join(", "),
     sourceType:"verified_auto_reservation",
   };
   const found=deductions.findIndex(d=>Number(d.employeeId)===employeeId&&d.code==="kasbon_deduction");
   if(found>=0)deductions[found]=entry;else deductions.push(entry);
 }
 return {deductions,issues,allocations,sourceRows};
}
export function finalizeAutomaticKasbonPreview(
 preview:ReturnType<typeof buildEffectiveSetupPreview>,
 projection:KasbonAutoProjection,
) {
 // Preserve the existing manual-Payroll preview and digest exactly when
 // there are no cash advances/plans/reservations for these employees.
 if(projection.sourceRows.size===0&&projection.issues.size===0&&projection.allocations.size===0)
   return preview;
 const rows=preview.rows.map(row=>{
   const problems=projection.issues.get(row.employeeId)??[];
   return {...row,
     net:problems.length?null:row.net,
     issues:[...new Set([...row.issues,...problems])],
     autoKasbon:projection.sourceRows.get(row.employeeId)??[],
   };
 });
 const extraInvalid=preview.rows.filter(r=>projection.issues.has(r.employeeId)).length;
 let gross=0n,deductions=0n,net=0n;
 for(const row of rows){
   if(row.net===null||row.gross===null||row.totalDeductions===null)continue;
   gross+=moneyToCents(row.gross);
   deductions+=moneyToCents(row.totalDeductions);
   net+=moneyToCents(row.net);
 }
 return {...preview,rows,invalidCount:preview.invalidCount+extraInvalid,
   gross:centsToMoney(gross),deductions:centsToMoney(deductions),net:centsToMoney(net),
   automaticKasbon:true as const};
}
