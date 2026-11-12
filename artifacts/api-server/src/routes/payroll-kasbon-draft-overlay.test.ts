import {describe,expect,it} from "vitest";
import {overlayAutomaticKasbon,finalizeAutomaticKasbonPreview,
 type KasbonAutoPlanRow,type KasbonAutoReservationRow} from "./payroll-kasbon-draft-overlay";
import {buildEffectiveSetupPreview,type EffectiveDeductionRow,type EffectiveSalaryRow} from "./payroll-setup-effective-preview";
import type {KasbonAdvance} from "./payroll-kasbon-automatic";

const employee:EffectiveSalaryRow={employeeId:51,firstName:"QA",lastName:"KASBON",
 baseSalary:"5000000.00",allowance:"1000000.00",salaryEffectiveFrom:"2026-11-01"};
const d:EffectiveDeductionRow[]=[
 {employeeId:51,code:"bpjs_jht_employee",amount:"0.00",effectiveFrom:"2026-11-01"},
 {employeeId:51,code:"bpjs_kes_employee",amount:"0.00",effectiveFrom:"2026-11-01"},
 {employeeId:51,code:"pph21",amount:"0.00",effectiveFrom:"2026-11-01"},
 {employeeId:51,code:"other_deductions",amount:"0.00",effectiveFrom:"2026-11-01"},
 {employeeId:51,code:"kasbon_deduction",amount:"0.00",effectiveFrom:"2026-11-01"},
];
const loan=(o:Partial<KasbonAdvance>={}):KasbonAdvance=>({
 id:101,companyId:1,employeeId:51,type:"kasbon",status:"partial",
 lifecycleStatus:"partially_settled",currency:"IDR",amount:"2000000.00",
 paidAmount:"500000.00",settledAmount:"0.00",remainingAmount:"1500000.00",
 approvedAt:"2026-10-01T09:00:00Z",approvedBy:"super-admin",
 disbursedAt:"2026-10-02T09:00:00Z",disbursedBy:"finance",
 accountingEntryId:9001,postingStatus:"posted",voidedAt:null,...o,
});
const plan=(o:Partial<KasbonAutoPlanRow>={}):KasbonAutoPlanRow=>({
 companyId:1,employeeId:51,advanceId:101,choice:"INSTALLMENT",
 installmentAmount:"500000.00",firstPeriod:"2026-11-01",updatedAt:"2026-11-10T10:00:00Z",
 ...o,
});
const reserve=(o:Partial<KasbonAutoReservationRow>={}):KasbonAutoReservationRow=>({
 companyId:1,employeeId:51,advanceId:101,runId:8,period:"2026-11-01",
 amount:"500000.00",balanceAtPreparation:"1500000.00",state:"prepared",...o,
});
function check(
 loans:KasbonAdvance[]=[loan()],plans:KasbonAutoPlanRow[]=[plan()],
 reservations:KasbonAutoReservationRow[]=[],manual:EffectiveDeductionRow[]=d,
 year=2026,month=11,run=8,
){
 const overlay=overlayAutomaticKasbon([employee],manual,loans,plans,
   reservations,1,run,year,month);
 const preview=finalizeAutomaticKasbonPreview(
   buildEffectiveSetupPreview([employee],overlay.deductions,year,month),
   overlay,
 );
 return {overlay,preview,row:preview.rows[0]};
}
describe("Automatic Payroll kasbon overlay — one reservation per loan and month",()=>{
 it("replaces manual zero with approved installment and computes salary net exactly",()=>{
  const {overlay,row,preview}=check();
  expect(row.deductions.kasbon_deduction).toBe("500000.00");
  expect(row.totalDeductions).toBe("500000.00");
  expect(row.net).toBe("5500000.00");
  expect(preview.invalidCount).toBe(0);
  expect(overlay.allocations.get(51)).toEqual([{advanceId:101,amount:"500000.00",balance:"1500000.00"}]);
  expect("autoKasbon" in row ? row.autoKasbon[0] : null)
    .toMatchObject({advanceId:101,planChoice:"INSTALLMENT",balance:"1500000.00"});
 });
 it("full pays only remaining balance, not original",()=>{
  const {row}=check([loan()],[plan({choice:"FULL",installmentAmount:null})]);
  expect(row.deductions.kasbon_deduction).toBe("1500000.00");
  expect(row.net).toBe("4500000.00");
 });
 it("requires a choice before deduction can enter a draft",()=>{
  const {row,preview}=check([loan()],[]);
  expect(row.net).toBeNull();
  expect(row.issues).toContain("PILIH_PENUH_ATAU_CICILAN");
  expect(preview.invalidCount).toBeGreaterThan(0);
 });
 it("cannot take manual and automatic deductions together",()=>{
  const manual=d.map(x=>x.code==="kasbon_deduction"?{...x,amount:"500000.00",notes:"Manual kasbon approval"}:x);
  const {row}=check([loan()],[plan()],[],manual);
  expect(row.issues).toContain("KASBON_MANUAL_DAN_OTOMATIS_BERSAMAAN");
  expect(row.net).toBeNull();
 });
 it("blocks a second payroll month until earlier reserved payroll is confirmed",()=>{
  const {row}=check([loan()],[plan()],[reserve()],d,2026,12,9);
  expect(row.issues).toContain("POTONGAN_PERIODE_LAIN_BELUM_DIKONFIRMASI");
  expect(row.net).toBeNull();
 });
 it("blocks other draft of same month and confirmed same-month reissue",()=>{
  const other=check([loan()],[plan()],[reserve({runId:99})]);
  expect(other.row.issues).toContain("KASBON_SUDAH_DIPERSIAPKAN_RUN_LAIN");
  const confirmed=check([loan()],[plan()],[reserve({state:"confirmed"})]);
  expect(confirmed.row.issues).toContain("KASBON_PERIODE_SUDAH_DIKONFIRMASI");
 });
 it("allows same-run retry without new deduction allocation duplication",()=>{
  const {row,overlay}=check([loan()],[plan()],[reserve()]);
  expect(row.net).toBe("5500000.00");
  expect(overlay.allocations.get(51)).toHaveLength(1);
 });
 it("fails closed if cash advance was repaid or voided after a Draft reservation",()=>{
  const settledLoan=loan({status:"repaid",lifecycleStatus:"settled",
    remainingAmount:"0.00",paidAmount:"2000000.00"});
  const {row}=check([settledLoan],[plan()],[reserve()]);
  expect(row.issues).toContain("RESERVASI_KASBON_SALDO_ATAU_STATUS_BERUBAH");
  expect(row.net).toBeNull();
 });
 it("fails closed if previous reserved amount differs after plan change",()=>{
  const {row}=check([loan()],[plan({installmentAmount:"600000.00"})],[reserve()]);
  expect(row.issues).toContain("PERUBAHAN_SETELAH_DRAFT_DISIAPKAN");
  expect(row.net).toBeNull();
 });
 it("fails closed when a saved plan loses advance eligibility before Draft materialization",()=>{
  const {row,preview,overlay}=check([loan({disbursedAt:null})],[plan()],[]);
  expect(row.issues).toContain("KASBON_PLAN_SOURCE_NOT_ELIGIBLE");
  expect(row.net).toBeNull();
  expect(preview.invalidCount).toBeGreaterThan(0);
  expect(overlay.allocations.get(51)).toEqual([]);
 });
 it("does not project draft/paid advances even if they look outstanding",()=>{
  const draft=loan({status:"DRAFT",lifecycleStatus:"outstanding",
    paidAmount:"0.00",remainingAmount:"2000000.00"});
  const {overlay,row}=check([draft],[]);
  expect(row.deductions.kasbon_deduction).toBe("0.00");
  expect(overlay.allocations.has(51)).toBe(false);
  expect(row.net).toBe("6000000.00");
 });
 it("never crosses company or employee identity boundaries",()=>{
  expect(()=>check([loan({companyId:2})])).toThrow("CROSS_COMPANY_KASBON_PROJECTION");
  expect(()=>check([loan({employeeId:52})])).toThrow("ORPHAN_KASBON_EMPLOYEE");
  expect(()=>check([loan()],[plan({employeeId:52})])).toThrow("ORPHAN_KASBON_EMPLOYEE");
 });
 it("records changed source/choice in digest-bearing preview rows",()=>{
  const x=check(),y=check([loan()],[plan({updatedAt:"2026-11-10T10:01:00Z"})]);
  expect(JSON.stringify(x.preview.rows)).not.toBe(JSON.stringify(y.preview.rows));
 });
});
