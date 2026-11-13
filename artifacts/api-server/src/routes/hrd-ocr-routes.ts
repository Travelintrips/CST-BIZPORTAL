import { randomUUID } from "node:crypto";
import type { IRouter, Request, Response } from "express";
import type { PoolClient } from "pg";
import { withHrdCompanyScope } from "./hrd-db";
import {
  createPrivateUpload, readPrivateObject, signedPrivatePreview,
  scanEmployeeDocument, documentHash, documentMimeMatches,
  validDocType, validMime, validateReviewFields,
  fieldsAllowedForDocument, allowedDocumentFields, hrdOcrReady,
  type HrdDocumentType,
} from "./hrd-document-ocr";

type ScopedRequest = Request & {hrdCompanyId?:number;hrdActor?:{email:string}};
const idValue=(value:unknown):number|null=>{
  if(typeof value!=="string"||!/^[1-9][0-9]*$/.test(value))return null;
  const n=Number(value);return Number.isSafeInteger(n)?n:null;
};
const docIdValue=(v:unknown):v is string=>typeof v==="string"&&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const extFor=(mime:string)=>({
  "application/pdf":"pdf","image/jpeg":"jpg","image/png":"png","image/webp":"webp",
} as Record<string,string>)[mime]??"invalid";
const unavailable=(res:Response)=>res.status(503).json({message:"OCR HRD PROD belum diaktifkan atau storage privat belum siap."});
const fail=(req:ScopedRequest,res:Response,error:unknown,operation:string)=>{
  req.log?.error?.({error,operation,companyId:req.hrdCompanyId},"HRD private OCR request failed");
  // Only pre-approved diagnostic codes: never return exception messages,
  // private document content, SQL, provider payloads or credentials.
  const raw=error instanceof Error?error.message:"";
  const safeCodes=new Set([
    "HRD_OCR_LOCAL_UNAVAILABLE","HRD_OCR_MIME_MISMATCH",
    "INVALID_DOCUMENT_SIZE","PRIVATE_DOCUMENT_NOT_UPLOADED",
    "HRD_OCR_FALLBACK_UNAVAILABLE",
  ]);
  const code=safeCodes.has(raw)||/^HRD_OCR_PROVIDER_HTTP_[45]\\d{2}(?:_[A-Z0-9_]+)?$/.test(raw)?
    raw:"HRD_OCR_SCAN_FAILED";
  res.setHeader("Cache-Control","no-store");
  res.status(503).json({
    message:code==="HRD_OCR_LOCAL_UNAVAILABLE"?
      "Mesin OCR lokal tidak tersedia. File tersimpan, tetapi belum dapat diekstrak.":
      code==="HRD_OCR_MIME_MISMATCH"?
      "Isi file tidak cocok dengan format dokumen yang dipilih.":
      "OCR dokumen belum berhasil. File aman; tidak ada perubahan identitas karyawan.",
    code,
  });
};
async function employeeExists(client:PoolClient,companyId:number,employeeId:number){
  const result=await client.query(
    "SELECT id FROM public.employees WHERE company_id=$1 AND id=$2 AND deleted_at IS NULL LIMIT 1",
    [companyId,employeeId],
  );return result.rowCount===1;
}
type StoredDocument={id:string;doc_type:HrdDocumentType;status:string;mime_type:string;storage_path:string};

export function registerHrdOcrRoutes(router:IRouter):void{
  router.post("/hrd/employees/:id/documents/prepare",async(req:ScopedRequest,res:Response)=>{
    if(!hrdOcrReady()){unavailable(res);return;}
    const employeeId=idValue(req.params.id),b=req.body??{};
    if(!employeeId||!validDocType(b.docType)||b.docType==="foto"||
       !validMime(b.mimeType)||b.processingAuthorizationConfirmed!==true){
      res.status(400).json({message:"Jenis, format, ID, atau persetujuan OCR tidak valid."});return;
    }
    const companyId=req.hrdCompanyId!,documentId=randomUUID(),actor=req.hrdActor!.email;
    const path=`${companyId}/${employeeId}/${documentId}.${extFor(b.mimeType)}`;
    try{
      const signed=await withHrdCompanyScope(companyId,async(client)=>{
        if(!await employeeExists(client,companyId,employeeId))return null;
        const authorization=await createPrivateUpload(path);
        await client.query(
          `INSERT INTO hrd_private.employee_documents
           (id,company_id,employee_id,doc_type,mime_type,storage_path,uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [documentId,companyId,employeeId,b.docType,b.mimeType,path,actor],
        );
        await client.query(
          `INSERT INTO hrd_private.employee_document_audit
           (company_id,employee_id,document_id,action,actor)
           VALUES ($1,$2,$3,'prepared',$4)`,[companyId,employeeId,documentId,actor],
        );
        return authorization;
      });
      if(!signed){res.status(404).json({message:"Karyawan tidak ditemukan."});return;}
      res.setHeader("Cache-Control","no-store");
      res.status(201).json({companyId,employeeId,documentId,path,...signed,maxBytes:5242880});
    }catch(error){fail(req,res,error,"prepare");}
  });

  router.post("/hrd/employees/:id/documents/:documentId/scan",async(req:ScopedRequest,res:Response)=>{
    if(!hrdOcrReady()){unavailable(res);return;}
    const employeeId=idValue(req.params.id),documentId=req.params.documentId;
    if(!employeeId||!docIdValue(documentId)||req.body?.processingAuthorizationConfirmed!==true){
      res.status(400).json({message:"Konfirmasi pemrosesan dan ID dokumen harus valid."});return;
    }
    const companyId=req.hrdCompanyId!,actor=req.hrdActor!.email;
    let doc:StoredDocument|undefined;
    try{
      doc=await withHrdCompanyScope(companyId,async(client)=>{
        const claim=await client.query(
          `UPDATE hrd_private.employee_documents
           SET status='scanning',updated_at=now()
           WHERE id=$1 AND company_id=$2 AND employee_id=$3
             AND doc_type<>'foto' AND (status IN ('upload_pending','scan_failed')
               OR (status='scanning' AND updated_at < now() - interval '15 minutes')
               OR (status='pending_review'
                   AND scanned_at < now() - interval '15 minutes'
                   AND verified_at IS NULL
                   AND original_sha256 IS NOT NULL
                   AND confidence = 0
                   AND jsonb_strip_nulls(coalesce(extracted_data,'{}'::jsonb))='{}'::jsonb))
           RETURNING id,doc_type,mime_type,storage_path,status`,
          [documentId,companyId,employeeId],
        );
        return claim.rowCount===1?claim.rows[0] as StoredDocument:undefined;
      });
    }catch(error){fail(req,res,error,"claim");return;}
    if(!doc){res.status(409).json({message:"Dokumen sedang/sudah diproses atau tidak ditemukan."});return;}
    try{
      const bytes=await readPrivateObject(doc.storage_path);
      if(!documentMimeMatches(bytes,doc.mime_type))throw Error("HRD_OCR_MIME_MISMATCH");
      const result=await scanEmployeeDocument(bytes,doc.mime_type,doc.doc_type);
      const permitted=allowedDocumentFields[doc.doc_type];
      const fields=Object.fromEntries(Object.entries(result.fields).filter(([key])=>
        permitted.includes(key as never)));
      const sha=documentHash(bytes);
      const recorded=await withHrdCompanyScope(companyId,async(client)=>{
        const update=await client.query(
          `UPDATE hrd_private.employee_documents
             SET status='pending_review',extracted_data=$1::jsonb,
                 confidence=$2,warnings=$3::jsonb,original_sha256=$4,
                 scanned_at=now(),updated_at=now()
           WHERE id=$5 AND company_id=$6 AND employee_id=$7 AND status='scanning'
           RETURNING id`,
          [JSON.stringify(fields),result.confidence,JSON.stringify(result.warnings),
           sha,documentId,companyId,employeeId],
        );
        if(update.rowCount!==1)return false;
        await client.query(
          `INSERT INTO hrd_private.employee_document_audit
            (company_id,employee_id,document_id,action,actor,changed_fields)
           VALUES ($1,$2,$3,'extracted',$4,$5)`,
          [companyId,employeeId,documentId,actor,Object.keys(fields).filter(k=>fields[k]!=null)],
        );return true;
      });
      if(!recorded){res.status(409).json({message:"Status dokumen berubah saat scan."});return;}
      res.setHeader("Cache-Control","no-store");
      res.json({companyId,employeeId,documentId,status:"pending_review",extracted:fields,
        confidence:result.confidence,warnings:result.warnings,engine:result.engine,
        requiresVerification:true,masterChanged:false});
    }catch(error){
      await withHrdCompanyScope(companyId,async(client)=>{
        const update=await client.query(
          `UPDATE hrd_private.employee_documents SET status='scan_failed',updated_at=now()
           WHERE id=$1 AND company_id=$2 AND employee_id=$3 AND status='scanning' RETURNING id`,
          [documentId,companyId,employeeId],
        );
        if(update.rowCount)await client.query(
          `INSERT INTO hrd_private.employee_document_audit
            (company_id,employee_id,document_id,action,actor)
           VALUES ($1,$2,$3,'scan_failed',$4)`,[companyId,employeeId,documentId,actor],
        );
      }).catch(()=>undefined);
      fail(req,res,error,"scan");
    }
  });

  router.post("/hrd/employees/:id/documents/:documentId/verify",async(req:ScopedRequest,res:Response)=>{
    if(!hrdOcrReady()){unavailable(res);return;}
    const employeeId=idValue(req.params.id),documentId=req.params.documentId;
    if(!employeeId||!docIdValue(documentId)||req.body?.confirm!==true){
      res.status(400).json({message:"Konfirmasi dan ID dokumen wajib valid."});return;
    }
    let fields:Record<string,string|null>;
    try{fields=validateReviewFields(req.body.fields);}
    catch{res.status(400).json({message:"Field koreksi HRD tidak valid."});return;}
    fields=Object.fromEntries(Object.entries(fields).filter(([,v])=>v!==null));
    const companyId=req.hrdCompanyId!,actor=req.hrdActor!.email;
    try{
      const outcome=await withHrdCompanyScope(companyId,async(client)=>{
        const result=await client.query(
          `SELECT id,status,doc_type FROM hrd_private.employee_documents
           WHERE id=$1 AND company_id=$2 AND employee_id=$3 FOR UPDATE`,
          [documentId,companyId,employeeId],
        );
        if(result.rowCount!==1||result.rows[0].status!=="pending_review"||
           result.rows[0].doc_type==="foto")return "conflict";
        if(!await employeeExists(client,companyId,employeeId))return "missing";
        const docType=result.rows[0].doc_type as HrdDocumentType;
        try{fieldsAllowedForDocument(docType,fields);}
        catch{return "invalid";}
        if(Object.keys(fields).length===0)return "empty";
        if(fields.nik){
          const conflict=await client.query(
            `SELECT employee_id FROM hrd_private.employee_profiles
             WHERE company_id=$1 AND employee_id<>$2
               AND verified_data->>'nik'=$3 LIMIT 1`,
            [companyId,employeeId,fields.nik],
          );
          if(conflict.rowCount)return "duplicate";
        }
        const sharedKeys=new Set(["nik","nama_lengkap","tempat_lahir","tanggal_lahir","alamat",
          "nomor_kk","anggota_keluarga","jenis_kelamin","agama","status_perkawinan",
          "rt_rw","kelurahan","kecamatan"]);
        const shared=docType==="ktp"||docType==="kk"
          ?Object.fromEntries(Object.entries(fields).filter(([key])=>sharedKeys.has(key))):{};
        if(Object.keys(shared).length){
          await client.query(
            `INSERT INTO hrd_private.employee_profiles
               (company_id,employee_id,verified_data,updated_by)
             VALUES($1,$2,$3::jsonb,$4)
             ON CONFLICT(company_id,employee_id) DO UPDATE
               SET verified_data=hrd_private.employee_profiles.verified_data||EXCLUDED.verified_data,
                   updated_by=EXCLUDED.updated_by,updated_at=now()`,
            [companyId,employeeId,JSON.stringify(shared),actor],
          );
        }
        const updated=await client.query(
          `UPDATE hrd_private.employee_documents
             SET status='verified',verified_data=$1::jsonb,verified_by=$2,
                 verified_at=now(),updated_at=now()
           WHERE id=$3 AND company_id=$4 AND employee_id=$5
             AND status='pending_review' RETURNING id`,
          [JSON.stringify(fields),actor,documentId,companyId,employeeId],
        );
        if(updated.rowCount!==1)throw Error("HRD_VERIFY_STATE_CONFLICT");
        await client.query(
          `INSERT INTO hrd_private.employee_document_audit
            (company_id,employee_id,document_id,action,actor,changed_fields,approved_data)
           VALUES($1,$2,$3,'verified',$4,$5,$6::jsonb)`,
          [companyId,employeeId,documentId,actor,Object.keys(fields),JSON.stringify(fields)],
        );
        return "verified";
      });
      if(outcome!=="verified"){
        res.status(outcome==="missing"?404:outcome==="conflict"||outcome==="duplicate"?409:400)
          .json({message:outcome==="duplicate"?"NIK sudah dipakai karyawan lain.":"Dokumen atau hasil koreksi tidak dapat diverifikasi."});
        return;
      }
      res.json({companyId,employeeId,documentId,status:"verified",masterChanged:false});
    }catch(error){fail(req,res,error,"verify");}
  });

  router.post("/hrd/employees/:id/documents/:documentId/preview",async(req:ScopedRequest,res:Response)=>{
    if(!hrdOcrReady()){unavailable(res);return;}
    const employeeId=idValue(req.params.id),documentId=req.params.documentId;
    if(!employeeId||!docIdValue(documentId)){res.status(400).json({message:"ID dokumen tidak valid."});return;}
    const companyId=req.hrdCompanyId!;
    try{
      const path=await withHrdCompanyScope(companyId,async(client)=>{
        const result=await client.query(
          `SELECT storage_path FROM hrd_private.employee_documents
           WHERE id=$1 AND company_id=$2 AND employee_id=$3
             AND doc_type<>'foto' AND status IN ('pending_review','verified')`,
          [documentId,companyId,employeeId],
        );
        return result.rows[0]?.storage_path as string|undefined;
      });
      if(!path){res.status(404).json({message:"Dokumen tidak ditemukan."});return;}
      const signed=await signedPrivatePreview(path);
      res.setHeader("Cache-Control","no-store");
      res.json(signed);
    }catch(error){fail(req,res,error,"preview");}
  });
}
