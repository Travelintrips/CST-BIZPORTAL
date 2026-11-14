import { hrdEmployeeStatusChangeEnabled } from "./hrd-employee-status-gate";
import type { IRouter, Request, Response } from "express";
import { withHrdCompanyScope } from "./hrd-db";

type ScopedHrdRequest=Request & {
  hrdCompanyId?:number;
  hrdActor?:{email:string;role:string};
};
const idOf=(input:unknown):number|null=>{
  if(typeof input!=="string"||!/^[1-9][0-9]*$/.test(input))return null;
  const parsed=Number(input);
  return Number.isSafeInteger(parsed)?parsed:null;
};
const enabled=hrdEmployeeStatusChangeEnabled;

/**
 * Uses the already-authorized, active BizPortal HRD session. All mutation and
 * audit queries execute under bizportal_hrd_prod with company RLS, never
 * through the unscoped postgres pool. Only ACTIVE -> INACTIVE is supported.
 */
export function registerHrdEmployeeStatusRoutes(router: IRouter):void {
  router.patch("/hrd/employees/:id/status",async(req:ScopedHrdRequest,res:Response):Promise<void>=>{
    res.setHeader("Cache-Control","no-store");
    if(!enabled()){res.status(501).json({message:"Pengelolaan status karyawan belum diaktifkan."});return;}
    if(req.get("origin")!=="https://bizportal.cstlogistic.co.id" ||
       req.get("x-hrd-status-intent")!=="deactivate-employee"){
      res.status(403).json({message:"Konfirmasi perubahan status tidak valid."});return;
    }
    const role=req.hrdActor?.role?.trim().toLowerCase();
    if(role!=="owner" && role!=="super_admin"){
      res.status(403).json({message:"Hanya Owner atau Super Admin HRD yang terverifikasi boleh menonaktifkan karyawan."});return;
    }
    const employeeId=idOf(req.params.id);
    const companyId=req.hrdCompanyId;
    const input=req.body;
    const reason=typeof input?.reason==="string"?input.reason.trim():"";
    if(!employeeId||!Number.isSafeInteger(companyId)||!companyId||companyId<1 ||
       input?.confirm!==true||input?.status!=="inactive"||
       reason.length<10||reason.length>500){
      res.status(400).json({message:"Pilih karyawan, konfirmasi Nonaktif/Resign, dan isi alasan HRD 10–500 karakter."});return;
    }
    const actorEmail=req.hrdActor?.email?.trim().toLowerCase()??"";
    if(!actorEmail || actorEmail.length>254){
      res.status(403).json({message:"Identitas HRD tidak valid."});return;
    }
    try {
      const result=await withHrdCompanyScope(companyId,async client=>{
        const current=await client.query(
          "SELECT id,status FROM public.employees WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL FOR UPDATE",
          [employeeId,companyId]);
        if(current.rowCount!==1)return {state:"not_found" as const};
        if(current.rows[0].status!=="active")return {state:"already_inactive" as const};

        const changed=await client.query(
          "UPDATE public.employees SET status='inactive' WHERE id=$1 AND company_id=$2 AND status='active' AND deleted_at IS NULL RETURNING id,status",
          [employeeId,companyId]);
        if(changed.rowCount!==1||changed.rows[0]?.status!=="inactive")
          throw Error("HRD_EMPLOYEE_RESIGN_READBACK_MISMATCH");
        const audit=await client.query(
          `INSERT INTO hrd_private.employee_status_audit
             (company_id,employee_id,previous_status,new_status,reason,actor_email)
           VALUES($1,$2,'active','inactive',$3,$4) RETURNING id`,
          [companyId,employeeId,reason,actorEmail]);
        if(audit.rowCount!==1||!audit.rows[0]?.id)
          throw Error("HRD_EMPLOYEE_STATUS_AUDIT_MISSING");
        return {state:"changed" as const};
      });
      if(result.state==="not_found"){
        res.status(404).json({message:"Karyawan tidak ditemukan pada perusahaan ini."});return;
      }
      if(result.state==="already_inactive"){
        res.status(409).json({message:"Karyawan sudah tidak aktif. Tidak ada perubahan."});return;
      }
      res.status(200).json({
        companyId,employeeId,previousStatus:"active",status:"inactive",
        auditRecorded:true,removedFromFuturePayroll:true,deleted:false,
        existingPayrollHistoryRetained:true,payrollPosted:false,payrollPaid:false,
      });
    }catch(error){
      req.log?.error?.({error,companyId,employeeId},"HRD employee resign status failed");
      res.status(503).json({message:"Gagal mengubah status. Perubahan dibatalkan tanpa menghapus data."});
    }
  });

  router.get("/hrd/employees/:id/status-history",async(req:ScopedHrdRequest,res:Response):Promise<void>=>{
    res.setHeader("Cache-Control","no-store");
    const employeeId=idOf(req.params.id);
    const companyId=req.hrdCompanyId;
    if(!employeeId||!Number.isSafeInteger(companyId)||!companyId||companyId<1){
      res.status(400).json({message:"Karyawan atau perusahaan tidak valid."});return;
    }
    try {
      const history=await withHrdCompanyScope(companyId,async client=>{
        const employee=await client.query(
          "SELECT id FROM public.employees WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL",
          [employeeId,companyId]);
        if(employee.rowCount!==1)return null;
        const rows=await client.query(
          `SELECT previous_status AS "previousStatus",new_status AS "status",
             reason,actor_email AS "changedBy",changed_at AS "changedAt"
             FROM hrd_private.employee_status_audit
             WHERE company_id=$1 AND employee_id=$2
             ORDER BY changed_at DESC,id DESC LIMIT 30`,[companyId,employeeId]);
        return rows.rows;
      });
      if(history===null){res.status(404).json({message:"Karyawan tidak ditemukan."});return;}
      res.json({companyId,employeeId,history});
    }catch{
      res.status(503).json({message:"Riwayat status karyawan belum tersedia."});
    }
  });
}
