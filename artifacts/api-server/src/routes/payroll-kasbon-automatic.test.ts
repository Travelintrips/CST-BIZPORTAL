import {describe,expect,it} from "vitest";
import {
  calculateKasbonAutoDeduction,
  type KasbonAdvance,type KasbonPlan,type KasbonPrepared,
} from "./payroll-kasbon-automatic";

const advance=(o:Partial<KasbonAdvance>={}):KasbonAdvance=>({
  id:101,companyId:1,employeeId:21,type:"kasbon",
  status:"partial",lifecycleStatus:"partially_settled",currency:"IDR",
  amount:"2000000.00",paidAmount:"500000.00",settledAmount:"0.00",
  remainingAmount:"1500000.00",approvedAt:"2026-10-01T09:00:00",approvedBy:"super-admin",
  disbursedAt:"2026-10-02T09:00:00",disbursedBy:"finance",accountingEntryId:9001,
  postingStatus:"posted",voidedAt:null,...o,
});
const plan=(o:Partial<KasbonPlan>={}):KasbonPlan=>({
  advanceId:101,choice:"INSTALLMENT",installmentAmount:"500000.00",firstPeriod:"2026-11-01",...o,
});
const project=(a:KasbonAdvance[]= [advance()],p:KasbonPlan[]=[plan()],
  prepared:KasbonPrepared[]=[],year=2026,month=11)=>
  calculateKasbonAutoDeduction(a,p,prepared,1,21,year,month);
describe("PROD-gated Kasbon FULL / INSTALLMENT — auto preview, NEVER settlement",()=>{
  it("selects one FULL deduction from the verified remaining balance",()=>{
    const result=project([advance()],[plan({choice:"FULL",installmentAmount:null})]);
    expect(result).toMatchObject({
      total:"1500000.00",canApply:true,canSettle:false,canPost:false,canPay:false,
      rows:[{advanceId:101,proposed:"1500000.00",balance:"1500000.00",issue:null}],
    });
  });
  it("INSTALLMENT uses fixed monthly value and caps the final payment at remaining",()=>{
    expect(project().total).toBe("500000.00");
    expect(project([advance({amount:"700000.00",paidAmount:"500000.00",remainingAmount:"200000.00"})]).total)
      .toBe("200000.00");
  });
  it("aggregates distinct eligible advances once per employee",()=>{
    const result=project([
      advance(),advance({id:102,amount:"100000.00",paidAmount:"0.00",remainingAmount:"100000.00",
      status:"active",lifecycleStatus:"disbursed",disbursedAt:"2026-10-20T10:00:00"}),
    ],[plan(),plan({advanceId:102,choice:"FULL",installmentAmount:null})]);
    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe("600000.00");
  });
  it("excludes any balance without approval, disbursement and posted journal evidence",()=>{
    expect(project([advance({approvedAt:null})],[plan()])).toMatchObject({total:null,canApply:false,
      rows:[{issue:"KASBON_PLAN_SOURCE_NOT_ELIGIBLE",proposed:null}]});
    expect(project([advance({approvedBy:"   "})],[plan()]).canApply).toBe(false);
    expect(project([advance({disbursedAt:null})],[plan()]).canApply).toBe(false);
    expect(project([advance({disbursedBy:null})],[plan()]).canApply).toBe(false);
    expect(project([advance({accountingEntryId:null})],[plan()]).canApply).toBe(false);
    expect(project([advance({postingStatus:"PENDING"})],[plan()]).canApply).toBe(false);
    expect(project([advance({voidedAt:"2026-11-01T10:00:00"})],[plan()]).canApply).toBe(false);
  });
  it("blocks a saved plan when its positive-balance advance loses approval or disbursement before Draft",()=>{
    const result=project([advance({disbursedAt:null})],[plan()]);
    expect(result).toMatchObject({total:null,canApply:false,
      rows:[{advanceId:101,issue:"KASBON_PLAN_SOURCE_NOT_ELIGIBLE",proposed:null}]});
  });
  it("never takes DRAFT kasbon even when outstanding-looking and associated",()=>{
    const result=project([
      advance({id:103,status:"DRAFT",lifecycleStatus:"outstanding",
        amount:"2000000.00",paidAmount:"0.00",remainingAmount:"2000000.00"}),
      advance(),
    ],[plan()]);
    expect(result.total).toBe("500000.00");
    expect(result.rows).toHaveLength(1);
  });
  it("never takes paid, void, rejected or non-disbursed active advances",()=>{
    const result=project([
      advance({id:201,status:"repaid",lifecycleStatus:"settled",remainingAmount:"0.00",paidAmount:"2000000.00"}),
      advance({id:202,status:"void",lifecycleStatus:"void",amount:"2000000.00",remainingAmount:"2000000.00",paidAmount:"0.00"}),
      advance({id:203,status:"active",lifecycleStatus:"outstanding",amount:"2000000.00",remainingAmount:"2000000.00",paidAmount:"0.00",disbursedAt:null}),
    ],[]);
    expect(result.total).toBe("0.00");
    expect(result.canApply).toBe(false);
  });
  it("blocks when an eligible employee advance lacks an explicit FULL / INSTALLMENT choice",()=>{
    const result=project([advance()],[]);
    expect(result).toMatchObject({total:null,canApply:false,rows:[{issue:"PILIH_PENUH_ATAU_CICILAN"}]});
  });
  it("blocks a second month while earlier prepared deduction remains unconfirmed",()=>{
    const result=project([advance()],[plan()],[{advanceId:101,period:"2026-11-01",amount:"500000.00",state:"prepared"}],2026,12);
    expect(result).toMatchObject({total:null,canApply:false,
      rows:[{issue:"POTONGAN_PERIODE_LAIN_BELUM_DIKONFIRMASI"}]});
  });
  it("permits same-month idempotent read but blocks altered amount after preparation",()=>{
    const same:[KasbonPrepared]=[{advanceId:101,period:"2026-11-01",amount:"500000.00",state:"prepared"}];
    expect(project([advance()],[plan()],same).rows[0].existingPreparation).toBe(true);
    expect(project([advance()],[plan({installmentAmount:"700000.00"})],same).rows[0].issue)
      .toBe("PERUBAHAN_SETELAH_DRAFT_DISIAPKAN");
  });
  it("refuses balance mismatch, cross-company employee, unsupported currency, and duplicate loans",()=>{
    expect(()=>project([advance({remainingAmount:"1400000.00"})])).toThrow("KASBON_BALANCE_MISMATCH");
    expect(()=>project([advance({companyId:2})])).toThrow("CROSS_COMPANY_KASBON");
    expect(()=>project([advance({currency:"USD"})])).toThrow("INVALID_KASBON_SOURCE");
    expect(()=>project([advance(),advance()])).toThrow("DUPLICATE_KASBON_ADVANCE");
  });
  it("rejects invalid installment plans, amounts, duplicates and non-calendar periods",()=>{
    expect(()=>project([advance()],[plan({installmentAmount:"0.00"})])).toThrow("INVALID_KASBON_INSTALLMENT");
    expect(()=>project([advance()],[plan({installmentAmount:"0.001"})])).toThrow("INVALID_KASBON_MONEY");
    expect(()=>project([advance()],[plan(),plan()])).toThrow("INVALID_KASBON_PLAN");
    expect(()=>project([advance()],[plan({choice:"FULL",installmentAmount:"1.00"})]))
      .toThrow("FULL_WITH_INSTALLMENT_AMOUNT");
    expect(()=>project([advance()],[plan({firstPeriod:"2026-11-05"})])).toThrow("INVALID_KASBON_PLAN");
  });
  it("respects start month and never creates a deduction earlier than authorized",()=>{
    const r=project([advance()],[plan({firstPeriod:"2026-12-01"})]);
    expect(r.total).toBe("0.00");
    expect(r.canApply).toBe(false);
  });
});
