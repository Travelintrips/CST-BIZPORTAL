import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getProductionSession, getProductionUser, type DevAuthUser } from "./dev-auth";
import { authorizePayrollCompany } from "./payroll-access";
import { payrollReadOnlyReady, payrollScopedQuery } from "./payroll-prod-db";

type ScopedRequest = Request & { advanceActor?: DevAuthUser; advanceCompanyId?: number };
type Row = Record<string,unknown>;
const router:IRouter=Router();
const positive=(v:unknown):number|null=>{
  if(typeof v!=="string"||!/^[1-9][0-9]*$/.test(v))return null;
  const n=Number(v);return Number.isSafeInteger(n)?n:null;
};
const number=(v:unknown)=>{const n=Number(v??0);if(!Number.isFinite(n)||n<0)throw Error("BAD_FINANCIAL_VALUE");return n;};
const first=(v:unknown)=>typeof v==="string"?v:"";

function verified(r:Row):boolean{
  return !["draft","void","repaid","rejected","cancelled"].includes(first(r.status).toLowerCase()) &&
    ["outstanding","partially_settled","disbursed"].includes(first(r.lifecycle_status)) &&
    r.approved_at!=null && first(r.approved_by).trim().length>0 &&
    r.disbursed_at!=null && first(r.disbursed_by).trim().length>0 &&
    r.accounting_entry_id!=null && first(r.posting_status).toLowerCase()==="posted" &&
    r.voided_at==null;
}
function normalized(r:Row){
  const isVerified=verified(r);
  const legacyStatus=first(r.status);
  const lifecycle=first(r.lifecycle_status).toLowerCase();
  return {
    id:number(r.id), company_id:number(r.company_id), employee_id:number(r.employee_id),
    advance_number:first(r.advance_number),advance_type:"EMPLOYEE",
    lifecycle_status:legacyStatus.toLowerCase()==="draft"?"draft":lifecycle,
    status:legacyStatus,
    posting_status:first(r.posting_status),
    party_name:first(r.employee_name)||"Karyawan tidak ditemukan",
    employee_name:first(r.employee_name)||null,
    amount:number(r.amount),remaining_amount:number(r.remaining_amount),
    settled_amount:number(r.settled_amount),paid_amount:number(r.paid_amount),
    date:first(r.advance_date),purpose:null,notes:null,
    receivable_account_code:null,receivable_account_name:null,
    cash_bank_account_code:null,cash_bank_account_name:null,
    entry_id:r.accounting_entry_id==null?null:number(r.accounting_entry_id),
    verified_disbursement:isVerified,
    requires_source_review:!isVerified && number(r.remaining_amount)>0,
    company_name:null,source_company_name:null,
    readOnly:true,coverage:"EMPLOYEE_KASBON_ONLY",
  };
}
const sql=`
  SELECT a.id,a.company_id,a.employee_id,a.advance_number,
    a.date::text AS advance_date,a.type,a.amount::text,a.remaining_amount::text,
    a.settled_amount::text,a.paid_amount::text,a.status,a.lifecycle_status,
    a.posting_status,a.approved_at,a.approved_by,a.disbursed_at,a.disbursed_by,
    a.accounting_entry_id,a.voided_at,
    btrim(concat_ws(' ',e.first_name,e.last_name)) AS employee_name
  FROM public.cash_advances a
  LEFT JOIN public.employees e ON e.id=a.employee_id AND e.company_id=a.company_id
  WHERE a.company_id=$1 AND a.type='kasbon'
  ORDER BY a.date DESC,a.id DESC LIMIT 2000
`;

async function auth(req:ScopedRequest,res:Response,next:NextFunction):Promise<void>{
  res.setHeader("Cache-Control","no-store");
  try{
    const session=getProductionSession(req);
    if(!session){res.status(401).json({message:"Sesi BizPortal diperlukan."});return;}
    const actor=await getProductionUser(session);
    if(!actor){res.status(403).json({message:"Akun BizPortal tidak berwenang."});return;}
    const companyId=authorizePayrollCompany(actor,req.query.companyId);
    if(companyId===null){res.status(403).json({message:"Pilih perusahaan yang sah. Kasbon tidak mendukung konsolidasi."});return;}
    if(process.env.APP_ENV?.trim().toLowerCase()!=="production"||!payrollReadOnlyReady()){
      res.status(503).json({message:"Koneksi baca-saja kasbon belum siap."});return;
    }
    req.advanceActor=actor;req.advanceCompanyId=companyId;next();
  }catch(e){
    req.log?.error?.({error:e},"Advance read-only authorization failed");
    res.status(503).json({message:"Otorisasi Advance tidak tersedia."});
  }
}
router.use("/advances",auth);
async function readRows(req:ScopedRequest):Promise<ReturnType<typeof normalized>[]>{
  const companyId=req.advanceCompanyId!;
  const result=await payrollScopedQuery(companyId,sql,[companyId]);
  return result.rows.map(normalized);
}
function queryFailure(req:ScopedRequest,res:Response,e:unknown){
  req.log?.error?.({error:e,companyId:req.advanceCompanyId},"Advance historical read unavailable");
  res.status(503).json({message:"Riwayat kasbon tidak dapat dibaca. Bukan berarti saldo kasbon Rp0."});
}
router.get("/advances",async(req:ScopedRequest,res:Response)=>{
  try{
    const rawType=first(req.query.advance_type);
    if(rawType && rawType!=="EMPLOYEE"){
      res.status(422).json({code:"ADVANCE_HISTORICAL_EMPLOYEE_ONLY",message:"Pembaca ini hanya mendukung kasbon karyawan. Data advance tipe lain belum terhubung."});
      return;
    }
    const page=req.query.page===undefined?1:positive(req.query.page);
    const limit=req.query.limit===undefined?50:positive(req.query.limit);
    if(page===null||limit===null||page>10000||limit>100){
      res.status(400).json({message:"Pagination Advance tidak valid."});return;
    }
    const status=first(req.query.lifecycle_status).toLowerCase();
    const party=first(req.query.party_name).toLowerCase().trim();
    const from=first(req.query.date_from),to=first(req.query.date_to);
    if(party.length>100|| (from&&!/^\d{4}-\d{2}-\d{2}$/.test(from)) ||
       (to&&!/^\d{4}-\d{2}-\d{2}$/.test(to))){
      res.status(400).json({message:"Filter Advance tidak valid."});return;
    }
    const all=await readRows(req);
    const filtered=all.filter(x=>(!status||x.lifecycle_status===status) &&
      (!party||x.party_name.toLowerCase().includes(party))&&(!from||x.date>=from)&&(!to||x.date<=to));
    res.json({
      data:filtered.slice((page-1)*limit,page*limit),total:filtered.length,
      companyId:req.advanceCompanyId,coverage:"EMPLOYEE_KASBON_ONLY",
      readOnly:true,canCreate:false,canApprove:false,canDisburse:false,canRepay:false,
      canVoid:false,canPostJournal:false,warning:"Hanya catatan kasbon historis, bukan saldo utang terverifikasi.",
    });
  }catch(e){queryFailure(req,res,e);}
});
router.get("/advances/dashboard",async(req:ScopedRequest,res:Response)=>{
  try{
    const all=await readRows(req);
    const open=all.filter(x=>x.remaining_amount>0);
    const verifiedOpen=open.filter(x=>x.verified_disbursement);
    const pendingReview=open.filter(x=>!x.verified_disbursement);
    res.json({
      companyId:req.advanceCompanyId,readOnly:true,coverage:"EMPLOYEE_KASBON_ONLY",
      stats:{
        outstanding_count:verifiedOpen.length,
        outstanding_amount:verifiedOpen.reduce((n,x)=>n+x.remaining_amount,0),
        total_remaining:verifiedOpen.reduce((n,x)=>n+x.remaining_amount,0),
        pending_count:pendingReview.length,
        total_settled:0,
        recorded_unverified_count:pendingReview.length,
        recorded_unverified_amount:pendingReview.reduce((n,x)=>n+x.remaining_amount,0),
      },
    });
  }catch(e){queryFailure(req,res,e);}
});
router.get("/advances/:id",async(req:ScopedRequest,res:Response)=>{
  const id=positive(req.params.id);
  if(!id){res.status(400).json({message:"ID Advance tidak valid."});return;}
  try{
    const all=await readRows(req);
    const row=all.find(x=>x.id===id);
    if(!row){res.status(404).json({message:"Kasbon tidak ada dalam perusahaan aktif."});return;}
    res.json({...row,settlements:[],repayments:[],installment_schedule:[],
      financialActionsDisabled:true,readOnly:true});
  }catch(e){queryFailure(req,res,e);}
});
export default router;
