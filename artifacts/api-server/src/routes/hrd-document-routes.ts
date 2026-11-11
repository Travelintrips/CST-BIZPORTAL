import {randomUUID} from "node:crypto";
import {type IRouter,type Request,type Response} from "express";
import {pool,type PayrollDbClient} from "@workspace/db";
import {createPrivateUpload,readPrivateObject,signedPrivatePreview,
 scanEmployeeDocument,documentHash,documentMimeMatches,validDocType,validMime,
 validateReviewFields,fieldsAllowedForDocument,allowedDocumentFields,hrdOcrReady,
 type HrdDocumentType} from "./hrd-document-ocr";

type HrdReq=Request&{payrollCompanyId?:number;payrollActor?:{
 role:string;email?:string;id?:number|string}};

const gate=(req:HrdReq,res:Response):boolean=>{
 if(process.env.APP_ENV!=="production"){
  res.status(404).json({message:"Dokumen HRD PROD tidak tersedia di lingkungan ini."});return false;
 }
 if(!Number.isSafeInteger(req.payrollCompanyId)||!req.payrollCompanyId||req.payrollCompanyId<1){
  res.status(404).json({message:"Perusahaan tidak ditemukan."});return false;
 }
 if(!["owner","super_admin"].includes(req.payrollActor?.role?.toLowerCase()??"")||
    !req.payrollActor?.email?.trim()){
  res.status(403).json({message:"Hanya Owner/Super Admin HRD yang dapat mengakses dokumen."});return false;
 }
 return true;
};
const integerId=(v:unknown):number|null=>{
 if(typeof v!=="string"||!/^[1-9][0-9]*$/.test(v))return null;
 const n=Number(v);return Number.isSafeInteger(n)?n:null;
};
const actor=(r:HrdReq)=>String(r.payrollActor?.email??"").trim().toLowerCase();
const databaseReady=()=>process.env.APP_ENV==="production"&&process.env.HRD_PROD_OCR_ENABLED==="true";
const ocrReady=()=>databaseReady()&&hrdOcrReady();
const ext=(mime:string)=>({
 "application/pdf":"pdf","image/jpeg":"jpg","image/png":"png","image/webp":"webp"
} as Record<string,string>)[mime];
type Doc={id:string;employee_id:number;company_id:number;status:string;
 mime_type:string;doc_type:string;storage_path:string;
 extracted_data:Record<string,unknown>;confidence:number|null;warnings:string[]};

async function scoped<T>(companyId:number,work:(client:PayrollDbClient)=>Promise<T>,readOnly=false):Promise<T>{
 if(!databaseReady())throw Error("HRD_PROD_DATABASE_NOT_READY");
 const client=await pool.connect();
 let active=false;
 try{
  await client.query(readOnly?"BEGIN READ ONLY":"BEGIN");active=true;
  await client.query("SET LOCAL ROLE bizportal_payroll_prod");
  await client.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(companyId)]);
  const result=await work(client);
  await client.query("COMMIT");active=false;
  return result;
 }catch(error){
  if(active)await client.query("ROLLBACK").catch(()=>{});
  throw error;
 }finally{client.release();}
}
async function checkEmployee(client:PayrollDbClient,id:number,companyId:number){
 const r=await client.query(
  "SELECT id,first_name,last_name,status,email,phone,position,hire_date FROM public.employees WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL",
  [id,companyId]);
 return r.rows[0]??null;
}
function failed(res:Response,error:unknown,message:string){
 const code=error&&typeof error==="object"&&"code" in error?String(error.code):"";
 res.status(code==="23505"?409:503).json({message});
}
// HRD uses the existing least-privilege Payroll PROD capability role inside
// each transaction, with the authenticated company scope set locally.
export function registerHrdDocumentRoutes(router:IRouter):void{
 router.get("/payroll/hrd/employees/:id",async(req:HrdReq,res:Response)=>{
  if(!gate(req,res))return;
  const id=integerId(req.params.id),companyId=req.payrollCompanyId!;
  if(!id){res.status(400).json({message:"ID karyawan tidak valid."});return;}
  if(!databaseReady()){res.status(503).json({message:"Koneksi HRD PROD terisolasi belum tersedia."});return;}
  try{
   const data=await scoped(companyId,async client=>{
    const employee=await checkEmployee(client,id,companyId);
    if(!employee)return null;
    const [profile,docs,audit]=await Promise.all([
     client.query("SELECT verified_data,updated_at FROM hrd_private.employee_profiles WHERE company_id=$1 AND employee_id=$2",[companyId,id]),
     client.query(`SELECT id,doc_type,mime_type,status,confidence,warnings,
       extracted_data,verified_data,created_at,verified_at FROM hrd_private.employee_documents
       WHERE company_id=$1 AND employee_id=$2 ORDER BY created_at DESC LIMIT 80`,[companyId,id]),
     client.query(`SELECT action,actor,changed_fields,approved_data,created_at
       FROM hrd_private.employee_document_audit
       WHERE company_id=$1 AND employee_id=$2 ORDER BY created_at DESC LIMIT 80`,[companyId,id])
    ]);
    return {employee,verifiedProfile:profile.rows[0]?.verified_data??{},
     documents:docs.rows,audit:audit.rows};
   },true);
   if(!data){res.status(404).json({message:"Karyawan tidak ditemukan."});return;}
   res.setHeader("Cache-Control","no-store");
   res.json({companyId,employeeId:id,...data,
    readOnly:!ocrReady(),canPay:false});
  }catch(err){failed(res,err,"Data HRD belum tersedia.");}
 });
 router.post("/payroll/hrd/employees/:id/documents/prepare",async(req:HrdReq,res:Response)=>{
  if(!gate(req,res))return;
  if(!ocrReady()){res.status(501).json({message:"Upload OCR HRD PROD belum diaktifkan atau koneksi Payroll DEV terisolasi belum siap."});return;}
  const employeeId=integerId(req.params.id),companyId=req.payrollCompanyId!,body=req.body??{};
  if(!employeeId||!validDocType(body.docType)||!validMime(body.mimeType)||
     body.processingAuthorizationConfirmed!==true){
   res.status(400).json({message:"Dokumen, format, atau persetujuan pemrosesan OCR belum valid."});return;
  }
  try{
   const prepared=await scoped(companyId,async client=>{
    if(!await checkEmployee(client,employeeId,companyId))return null;
    const documentId=randomUUID();
    const path=`${companyId}/${employeeId}/${documentId}.${ext(body.mimeType)}`;
    const authorization=await createPrivateUpload(path);
    await client.query(`INSERT INTO hrd_private.employee_documents
     (id,employee_id,company_id,doc_type,mime_type,storage_path,uploaded_by)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
     [documentId,employeeId,companyId,body.docType,body.mimeType,path,actor(req)]);
    await client.query(`INSERT INTO hrd_private.employee_document_audit
     (employee_id,company_id,document_id,action,actor)
     VALUES($1,$2,$3,'prepared',$4)`,[employeeId,companyId,documentId,actor(req)]);
    return {documentId,path,...authorization,maxBytes:5*1024*1024};
   });
   if(!prepared){res.status(404).json({message:"Karyawan tidak ditemukan."});return;}
   res.setHeader("Cache-Control","no-store");
   res.status(201).json(prepared);
  }catch(err){failed(res,err,"Pembuatan upload privat HRD gagal, tidak ada profil diubah.");}
 });
 router.post("/payroll/hrd/employees/:id/documents/:documentId/scan",async(req:HrdReq,res:Response)=>{
  if(!gate(req,res))return;
  if(!ocrReady()){res.status(501).json({message:"OCR HRD PROD belum diaktifkan atau koneksi Payroll DEV terisolasi belum siap."});return;}
  const employeeId=integerId(req.params.id),companyId=req.payrollCompanyId!,documentId=req.params.documentId;
  if(!employeeId||typeof documentId!=="string"||!/^[a-f0-9-]{36}$/i.test(documentId)||
     req.body?.processingAuthorizationConfirmed!==true){
   res.status(400).json({message:"ID dokumen dan konfirmasi pemrosesan OCR wajib valid sebelum scan atau coba scan lagi."});return;
  }
  let doc:Doc|null;
  try{
   doc=await scoped(companyId,async client=>{
    const claim=await client.query(`UPDATE hrd_private.employee_documents
     SET status='scanning',updated_at=now()
     WHERE id=$1 AND employee_id=$2 AND company_id=$3
      AND status IN ('upload_pending','scan_failed')
     RETURNING id,doc_type,mime_type,storage_path`,[documentId,employeeId,companyId]);
    return claim.rowCount===1?claim.rows[0] as Doc:null;
   });
  }catch(err){failed(res,err,"Klaim dokumen untuk scan gagal.");return;}
  if(!doc){res.status(409).json({message:"Dokumen tidak tersedia atau sedang/sudah diproses."});return;}
  try{
   const bytes=await readPrivateObject(doc.storage_path);
   if(!documentMimeMatches(bytes,doc.mime_type))throw Error("MIME_MAGIC_MISMATCH");
   const docType=doc.doc_type as HrdDocumentType;
   const extracted=await scanEmployeeDocument(bytes,doc.mime_type,docType);
   const permitted=allowedDocumentFields[docType];
   const safeFields=Object.fromEntries(Object.entries(extracted.fields).filter(([k])=>permitted.includes(k as any)));
   const hash=documentHash(bytes);
   await scoped(companyId,async client=>{
    const updated=await client.query(`UPDATE hrd_private.employee_documents SET
     status='pending_review',extracted_data=$1::jsonb,confidence=$2,
     warnings=$3::jsonb,original_sha256=$4,scanned_at=now(),updated_at=now()
     WHERE id=$5 AND company_id=$6 AND employee_id=$7 AND status='scanning'
     RETURNING id`,
     [JSON.stringify(safeFields),extracted.confidence,JSON.stringify(extracted.warnings),hash,
      documentId,companyId,employeeId]);
    if(updated.rowCount!==1)throw Error("SCAN_STATE_CONFLICT");
    await client.query(`INSERT INTO hrd_private.employee_document_audit
     (employee_id,company_id,document_id,action,actor,changed_fields)
     VALUES($1,$2,$3,'extracted',$4,$5)`,
     [employeeId,companyId,documentId,actor(req),Object.keys(safeFields).filter(k=>safeFields[k]!=null)]);
   });
   res.setHeader("Cache-Control","no-store");
   res.json({companyId:companyId,employeeId,documentId,status:"pending_review",
    extracted:safeFields,confidence:extracted.confidence,warnings:extracted.warnings,engine:extracted.engine,
    requiresVerification:true,masterChanged:false});
  }catch(err){
   await scoped(companyId,async client=>{
    const changed=await client.query(`UPDATE hrd_private.employee_documents
     SET status='scan_failed',updated_at=now() WHERE id=$1 AND employee_id=$2
      AND company_id=$3 AND status='scanning' RETURNING id`,
     [documentId,employeeId,companyId]);
    if(changed.rowCount)await client.query(`INSERT INTO hrd_private.employee_document_audit
     (employee_id,company_id,document_id,action,actor)
     VALUES($1,$2,$3,'scan_failed',$4)`,[employeeId,companyId,documentId,actor(req)]);
   }).catch(()=>{});
   const rawCode=err instanceof Error?err.message:"";
   const code=/^(?:HRD_[A-Z0-9_]+|PRIVATE_[A-Z0-9_]+|INVALID_[A-Z0-9_]+|MIME_[A-Z0-9_]+|SCAN_[A-Z0-9_]+)$/.test(rawCode)
    ?rawCode:"HRD_SCAN_UNKNOWN";
   const message=code.includes("NOT_CONFIGURED")
    ?`Konfigurasi OCR privat belum tersedia di server PROD (kode ${code}).`
    :`Scan dokumen gagal (kode ${code}). Profil karyawan tidak diubah.`;
   res.status(503).json({message,code});
  }
 });
 router.post("/payroll/hrd/employees/:id/documents/:documentId/verify",async(req:HrdReq,res:Response)=>{
  if(!gate(req,res))return;
  if(!ocrReady()){res.status(501).json({message:"Verifikasi OCR HRD PROD belum aktif."});return;}
  const employeeId=integerId(req.params.id),companyId=req.payrollCompanyId!,documentId=req.params.documentId;
  if(!employeeId||typeof documentId!=="string"||!/^[a-f0-9-]{36}$/i.test(documentId)||req.body?.confirm!==true){
   res.status(400).json({message:"Konfirmasi dan ID dokumen wajib valid."});return;
  }
  let fields:Record<string,string|null>;
  try{fields=validateReviewFields(req.body.fields);}catch{
   res.status(400).json({message:"Field hasil scan tidak valid."});return;
  }
  fields=Object.fromEntries(Object.entries(fields).filter(([,value])=>value!==null));
  try{
   const outcome=await scoped(companyId,async client=>{
    const doc=await client.query(`SELECT id,status,doc_type,extracted_data FROM
     hrd_private.employee_documents WHERE id=$1 AND employee_id=$2 AND company_id=$3
     FOR UPDATE`,[documentId,employeeId,companyId]);
    if(doc.rowCount!==1||doc.rows[0].status!=="pending_review")return {kind:"conflict" as const};
    if(!await checkEmployee(client,employeeId,companyId))return {kind:"employee_missing" as const};
    let approved:Record<string,string|null>;
    try{approved=fieldsAllowedForDocument(doc.rows[0].doc_type as HrdDocumentType,fields);}
    catch{return {kind:"invalid_fields" as const};}
    if(Object.keys(approved).length===0&&doc.rows[0].doc_type!=="foto")return {kind:"empty" as const};
    if(approved.nik){
     const duplicate=await client.query(`SELECT employee_id FROM hrd_private.employee_profiles
      WHERE company_id=$1 AND employee_id<>$2 AND verified_data->>'nik'=$3 LIMIT 1`,
      [companyId,employeeId,approved.nik]);
     if(duplicate.rowCount)return {kind:"duplicate" as const};
    }
    // Keep document-specific values on their own document. Only KTP/KK
    // identity fields feed the shared HRD identity profile; other document
    // numbers and dates must never overwrite another document's values.
    const profileKeys=new Set([
     "nik","nama_lengkap","tempat_lahir","tanggal_lahir","alamat","nomor_kk",
     "jenis_kelamin","agama","status_perkawinan","rt_rw","kelurahan","kecamatan",
     "anggota_keluarga"
    ]);
    const profileApproved=(doc.rows[0].doc_type==="ktp"||doc.rows[0].doc_type==="kk")
     ?Object.fromEntries(Object.entries(approved).filter(([key])=>profileKeys.has(key)))
     :{};
    if(Object.keys(profileApproved).length>0)await client.query(`INSERT INTO hrd_private.employee_profiles
     (employee_id,company_id,verified_data,updated_by)
     VALUES($1,$2,$3::jsonb,$4)
     ON CONFLICT(employee_id) DO UPDATE
      SET verified_data=hrd_private.employee_profiles.verified_data||EXCLUDED.verified_data,
       updated_by=EXCLUDED.updated_by,updated_at=now()
      WHERE hrd_private.employee_profiles.company_id=$2`,
     [employeeId,companyId,JSON.stringify(profileApproved),actor(req)]);
    const updated=await client.query(`UPDATE hrd_private.employee_documents
     SET status='verified',verified_data=$1::jsonb,verified_by=$2,
      verified_at=now(),updated_at=now()
     WHERE id=$3 AND company_id=$4 AND employee_id=$5 AND status='pending_review'
     RETURNING id`,[JSON.stringify(approved),actor(req),documentId,companyId,employeeId]);
    if(updated.rowCount!==1)throw Error("HRD_VERIFY_STATE_CONFLICT");
    await client.query(`INSERT INTO hrd_private.employee_document_audit
     (employee_id,company_id,document_id,action,actor,changed_fields,approved_data)
     VALUES($1,$2,$3,'verified',$4,$5,$6::jsonb)`,
     [employeeId,companyId,documentId,actor(req),Object.keys(approved),JSON.stringify(approved)]);
    return {kind:"verified" as const,profileUpdated:Object.keys(profileApproved).length>0};
   });
   if(outcome.kind==="conflict"){res.status(409).json({message:"Dokumen sudah diproses atau bukan menunggu verifikasi."});return;}
   if(outcome.kind==="employee_missing"){res.status(404).json({message:"Karyawan tidak ditemukan."});return;}
   if(outcome.kind==="invalid_fields"){res.status(400).json({message:"Field tidak sesuai jenis dokumen."});return;}
   if(outcome.kind==="empty"){res.status(400).json({message:"Tidak ada data terbaca untuk diverifikasi."});return;}
   if(outcome.kind==="duplicate"){res.status(409).json({message:"NIK terdaftar pada karyawan lain. Verifikasi ditolak."});return;}
   res.setHeader("Cache-Control","no-store");
   res.json({employeeId,documentId,status:"verified",profileUpdated:outcome.profileUpdated,
    legacyMasterUpdated:false,canPay:false});
  }catch(err){failed(res,err,"Pengesahan OCR gagal. Perubahan data dibatalkan.");}
 });
 router.post("/payroll/hrd/employees/:id/documents/:documentId/preview",async(req:HrdReq,res:Response)=>{
  if(!gate(req,res))return;
  const employeeId=integerId(req.params.id),companyId=req.payrollCompanyId!,documentId=req.params.documentId;
  if(!employeeId||typeof documentId!=="string"||!/^[a-f0-9-]{36}$/i.test(documentId)){
   res.status(400).json({message:"Dokumen tidak valid."});return;
  }
  if(!databaseReady()){res.status(503).json({message:"Koneksi HRD PROD terisolasi belum tersedia."});return;}
  try{
   const row=await scoped(companyId,client=>client.query(`SELECT storage_path FROM hrd_private.employee_documents
    WHERE company_id=$1 AND employee_id=$2 AND id=$3 AND status<>'upload_pending'`,
    [companyId,employeeId,documentId]),true);
   if(!row.rowCount){res.status(404).json({message:"Dokumen tidak ditemukan."});return;}
   const signed=await signedPrivatePreview(row.rows[0].storage_path);
   res.setHeader("Cache-Control","no-store");res.json(signed);
  }catch(err){failed(res,err,"Pratinjau privat tidak tersedia.");}
 });
}
