import type {IRouter,Request,Response,NextFunction} from "express";
import type {PayrollDbClient} from "@workspace/db";
import {getPayrollPool,payrollProdDedicatedRequired,setPayrollCompanyScope} from "./payroll-prod-db";
import {isPayrollProdApprover} from "./payroll-prod-approver";

type ScopedRequest=Request&{payrollCompanyId?:number;payrollActor?:{role:string}};
/** Production-only opt-in Draft creation. Never uses the shared BizPortal pool.
 *  Does not generate items, post GL, pay salaries, or settle cash advances.
 */
export function registerProdPayrollDraftRoutes(router:IRouter):void {
  router.post("/payroll/runs",async(req:ScopedRequest,res:Response,next:NextFunction):Promise<void>=>{
    if(process.env.APP_ENV?.trim().toLowerCase()!=="production"){next();return;}
    const enabled=process.env.PAYROLL_PROD_DRAFT_ENABLED==="true" && payrollProdDedicatedRequired();
    if(!enabled){
      res.status(501).json({message:"Pembuatan Draft Payroll PROD belum diaktifkan secara eksplisit."});
      return;
    }
    if(!isPayrollProdApprover(req.payrollActor,req.payrollCompanyId)){
      res.status(403).json({message:"Hanya Super Admin boleh membuat Draft Payroll PROD."});
      return;
    }
    const scope=req.payrollCompanyId;
    const {month,year,notes}=req.body??{};
    if(!Number.isSafeInteger(scope)||scope! <= 0 ||
       !Number.isInteger(month)||month<1||month>12||
       !Number.isInteger(year)||year<2020||year>2100||
       (notes!==undefined&&(typeof notes!=="string"||notes.length>500))){
      res.status(400).json({message:"Perusahaan, bulan, tahun, atau catatan Payroll tidak valid."});
      return;
    }
    const companyId=scope!;
    let client:PayrollDbClient|undefined,active=false;
    try {
      client=await getPayrollPool().connect();
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");active=true;
      await setPayrollCompanyScope(client,companyId);
      await client.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)",
        [companyId,year*100+month]);
      const existing=await client.query(
        "SELECT id FROM public.payroll_runs WHERE company_id=$1 AND month=$2 AND year=$3 LIMIT 1",
        [companyId,month,year]);
      if(existing.rowCount){
        await client.query("ROLLBACK");active=false;
        res.status(409).json({message:"Periode Payroll perusahaan ini sudah ada."});return;
      }
      const inserted=await client.query(
        `INSERT INTO public.payroll_runs
          (company_id,month,year,status,posting_status,notes,accounting_entry_id,payment_entry_id)
         VALUES ($1,$2,$3,'draft','pending',$4,NULL,NULL)
         RETURNING id,company_id,month,year,status,posting_status,accounting_entry_id,payment_entry_id`,
        [companyId,month,year,notes?.trim()||null]);
      if(inserted.rowCount!==1)throw Error("PAYROLL_PROD_DRAFT_INSERT_NOT_CONFIRMED");
      await client.query("COMMIT");active=false;
      const run=inserted.rows[0];
      res.setHeader("Cache-Control","no-store");
      res.status(201).json({run:{
        id:Number(run.id),companyId:Number(run.company_id),
        month:Number(run.month),year:Number(run.year),
        status:String(run.status),postingStatus:String(run.posting_status),
        integrityError:null,
      },created:true,generatedItems:false,approved:false,posted:false,paid:false});
    }catch(error){
      if(active&&client)try{await client.query("ROLLBACK");}catch{}
      req.log?.error?.({error,companyId},"Payroll PROD gated Draft create failed");
      res.status(503).json({message:"Pembuatan Draft Payroll PROD gagal; transaksi dibatalkan."});
    }finally{client?.release();}
  });
}
