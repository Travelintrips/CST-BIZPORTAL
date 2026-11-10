import { type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";

type ScopedPayrollRequest = Request & {
  payrollCompanyId?: number;
  payrollActor?: { role: string };
};

const codes = [
  "bpjs_jht_employee", "bpjs_kes_employee", "pph21",
  "other_deductions", "kasbon_deduction",
] as const;
const fields = [
  "baseSalary","allowance","bpjsJhtEmployee","bpjsKesEmployee","pph21",
  "otherDeductions","kasbonDeduction",
] as const;
type MoneyField = typeof fields[number];
const notesLimit = 500;
const moneyPattern = /^(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,2}))?$/;

function parseMoney(value: unknown): bigint | null {
  if (typeof value !== "string" || !moneyPattern.test(value)) return null;
  const [whole, decimal = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(decimal.padEnd(2,"0"));
}
function formatMoney(value: bigint): string {
  return (value / 100n) + "." + (value % 100n).toString().padStart(2,"0");
}
function employeeIdFrom(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
function validDate(raw: unknown): raw is string {
  if (typeof raw !== "string" || !/^20\d\d-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(raw)) return false;
  const d = new Date(raw + "T00:00:00Z");
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0,10) === raw;
}
function canRead(req: ScopedPayrollRequest): boolean {
  return ["owner","super_admin"].includes(req.payrollActor?.role?.toLowerCase() ?? "");
}
const enabled = () => process.env.PAYROLL_PROD_COMPONENTS_ENABLED === "true";
function unavailable(res: Response, write: boolean) {
  res.status(write ? 501 : 404).json({message:"Konfigurasi komponen Payroll PROD belum diaktifkan."});
}
function safeMessage(res: Response) {
  res.status(503).json({message:"Konfigurasi Payroll tidak dapat diakses atau disimpan; perubahan dibatalkan."});
}

export function registerStandalonePayrollComponents(router: IRouter): void {
  router.get("/payroll/components/employees", async (req: ScopedPayrollRequest,res: Response): Promise<void> => {
    if (!enabled()) return unavailable(res,false);
    if (!canRead(req)) {res.status(403).json({message:"Tidak berwenang melihat gaji."});return;}
    const companyId=req.payrollCompanyId!;
    let c;
    try {
      c=await pool.connect();
      await c.query("BEGIN READ ONLY");
      await c.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(companyId)]);
      const r=await c.query(
        "SELECT id, first_name AS \"firstName\",last_name AS \"lastName\" FROM public.employees WHERE company_id=$1 AND status='active' AND deleted_at IS NULL ORDER BY first_name,last_name,id LIMIT 300",
        [companyId]);
      await c.query("ROLLBACK");
      res.setHeader("Cache-Control","no-store");
      res.json({companyId,employees:r.rows.map(x=>({...x,id:Number(x.id)})),canEdit:true});
    } catch(e) {
      if(c)try{await c.query("ROLLBACK");}catch{}
      req.log?.error?.({e,companyId},"Payroll standalone employee read failed");
      safeMessage(res);
    }finally{c?.release();}
  });

  router.get("/payroll/components/:employeeId", async(req:ScopedPayrollRequest,res:Response):Promise<void>=>{
    if (!enabled()) return unavailable(res,false);
    if (!canRead(req)) {res.status(403).json({message:"Tidak berwenang melihat gaji."});return;}
    const id=employeeIdFrom(req.params.employeeId);
    if(!id){res.status(400).json({message:"ID karyawan tidak valid."});return;}
    const companyId=req.payrollCompanyId!;
    let c;
    try {
      c=await pool.connect();
      await c.query("BEGIN READ ONLY");
      await c.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(companyId)]);
      const e=await c.query("SELECT id FROM public.employees WHERE id=$1 AND company_id=$2 AND status='active' AND deleted_at IS NULL",[id,companyId]);
      if(e.rowCount!==1){await c.query("ROLLBACK");res.status(404).json({message:"Karyawan aktif tidak ditemukan."});return;}
      const s=await c.query(
        `SELECT effective_from::text AS "effectiveFrom",base_salary::text AS "baseSalary",
          allowance::text AS "allowance",notes
         FROM public.payroll_salary_profiles
        WHERE company_id=$1 AND employee_id=$2 ORDER BY effective_from DESC,id DESC LIMIT 1`,
        [companyId,id]);
      let deductions: Array<{code:string;amount:string;notes:string}>=[];
      if(s.rowCount){
        const dd=await c.query(
          `SELECT code,amount::text AS amount,notes FROM public.payroll_deduction_settings
           WHERE company_id=$1 AND employee_id=$2 AND effective_from=$3::date`,
          [companyId,id,s.rows[0].effectiveFrom]);
        deductions=dd.rows;
      }
      await c.query("ROLLBACK");
      const values:Record<string,string|null>={baseSalary:s.rows[0]?.baseSalary??null,allowance:s.rows[0]?.allowance??null,
        bpjsJhtEmployee:null,bpjsKesEmployee:null,pph21:null,otherDeductions:null,kasbonDeduction:null};
      const keyForCode:Record<string,string>={
        bpjs_jht_employee:"bpjsJhtEmployee",bpjs_kes_employee:"bpjsKesEmployee",pph21:"pph21",
        other_deductions:"otherDeductions",kasbon_deduction:"kasbonDeduction",
      };
      for(const d of deductions)if(keyForCode[d.code])values[keyForCode[d.code]]=d.amount;
      const complete=fields.every(f=>values[f]!==null);
      let summary:null|{gross:string;deductions:string;net:string}=null;
      if(complete){
        const gross=parseMoney(values.baseSalary)!+parseMoney(values.allowance)!;
        const total=fields.slice(2).reduce((n,f)=>n+parseMoney(values[f])!,0n);
        if(total<=gross)summary={gross:formatMoney(gross),deductions:formatMoney(total),net:formatMoney(gross-total)};
      }
      res.setHeader("Cache-Control","no-store");
      res.json({companyId,employeeId:id,effectiveFrom:s.rows[0]?.effectiveFrom??null,
        notes:s.rows[0]?.notes??"",values,complete,summary,
        canPost:false,canPay:false});
    }catch(e){
      if(c)try{await c.query("ROLLBACK");}catch{}
      req.log?.error?.({e,companyId,id},"Payroll standalone component read failed");
      safeMessage(res);
    }finally{c?.release();}
  });

  router.put("/payroll/components/:employeeId",async(req:ScopedPayrollRequest,res:Response):Promise<void>=>{
    if (!enabled())return unavailable(res,true);
    if(!canRead(req)){res.status(403).json({message:"Hanya Owner atau Super Admin boleh menyimpan gaji."});return;}
    const id=employeeIdFrom(req.params.employeeId);
    if(!id){res.status(400).json({message:"ID karyawan tidak valid."});return;}
    const data=req.body;
    if(!data || typeof data!=="object" || Array.isArray(data) ||
      Object.keys(data).some(k=>![...fields,"effectiveFrom","notes"].includes(k))){
      res.status(400).json({message:"Hanya tujuh komponen gaji, tanggal, dan catatan diizinkan."});return;
    }
    if(!validDate(data.effectiveFrom)||typeof data.notes!=="string"||data.notes.length>notesLimit){
      res.status(400).json({message:"Tanggal atau catatan tidak valid."});return;
    }
    const money={} as Record<MoneyField,bigint>;
    for(const f of fields){
      const value=parseMoney(data[f]);
      if(value===null){res.status(400).json({message:"Ketujuh nominal wajib diisi; Rp0 harus dinyatakan eksplisit."});return;}
      money[f]=value;
    }
    if(money.baseSalary<=0n){res.status(400).json({message:"Gaji pokok harus lebih besar dari nol."});return;}
    if(money.kasbonDeduction>0n&&data.notes.trim().length<5){
      res.status(400).json({message:"Potongan kasbon membutuhkan catatan sumber minimal lima karakter."});return;
    }
    const gross=money.baseSalary+money.allowance;
    const deductions=fields.slice(2).reduce((n,f)=>n+money[f],0n);
    if(deductions>gross){res.status(409).json({message:"Potongan melebihi gaji kotor."});return;}
    const companyId=req.payrollCompanyId!;
    let c;let active=false;
    try {
      c=await pool.connect();
      await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");active=true;
      await c.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(companyId)]);
      await c.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)",[companyId,id]);
      const emp=await c.query("SELECT id FROM public.employees WHERE company_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL FOR UPDATE",[companyId,id]);
      if(emp.rowCount!==1){await c.query("ROLLBACK");active=false;res.status(404).json({message:"Karyawan aktif tidak ditemukan."});return;}
      await c.query(`INSERT INTO public.payroll_salary_profiles
        (company_id,employee_id,effective_from,base_salary,allowance,notes)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT(company_id,employee_id,effective_from) DO UPDATE
        SET base_salary=EXCLUDED.base_salary,allowance=EXCLUDED.allowance,notes=EXCLUDED.notes,updated_at=now()`,
        [companyId,id,data.effectiveFrom,formatMoney(money.baseSalary),formatMoney(money.allowance),data.notes]);
      const vals=[
        ["bpjs_jht_employee","bpjsJhtEmployee"],["bpjs_kes_employee","bpjsKesEmployee"],
        ["pph21","pph21"],["other_deductions","otherDeductions"],["kasbon_deduction","kasbonDeduction"],
      ] as const;
      for(const [code,field] of vals){
        await c.query(`INSERT INTO public.payroll_deduction_settings
          (company_id,employee_id,effective_from,code,amount,notes)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT(company_id,employee_id,effective_from,code) DO UPDATE
          SET amount=EXCLUDED.amount,notes=EXCLUDED.notes,updated_at=now()`,
          [companyId,id,data.effectiveFrom,code,formatMoney(money[field]),data.notes]);
      }
      await c.query("COMMIT");active=false;
      res.setHeader("Cache-Control","no-store");
      res.json({companyId,employeeId:id,componentsSaved:7,gross:formatMoney(gross),
        deductions:formatMoney(deductions),net:formatMoney(gross-deductions),
        appliedToPayroll:false,posted:false,paid:false,settledKasbon:false});
    }catch(e){
      if(active&&c)try{await c.query("ROLLBACK")}catch{}
      req.log?.error?.({e,companyId,id},"Payroll standalone components write failed");
      safeMessage(res);
    }finally{c?.release();}
  });
}
