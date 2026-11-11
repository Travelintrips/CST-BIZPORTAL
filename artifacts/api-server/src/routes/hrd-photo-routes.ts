import { randomUUID } from "node:crypto";
import type { IRouter, Request, Response } from "express";
import { withHrdCompanyScope } from "./hrd-db";
import {
  createHrdPhotoSignedUpload, hrdPrivateStorageReady, photoSha256,
  readHrdPhoto, signHrdPhotoPreview, validPhotoBytes, validPhotoMime,
} from "./hrd-photo-storage";

type HrdPhotoRequest = Request & {
  hrdCompanyId?: number;
  hrdActor?: { email: string };
};
const integerId = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail = (res: Response) => {
  res.status(503).json({message:"Layanan dokumen privat HRD belum tersedia."});
};

export function registerHrdPhotoRoutes(router: IRouter): void {
  router.post("/hrd/employees/:id/photo/prepare", async (req: HrdPhotoRequest, res: Response) => {
    if (!hrdPrivateStorageReady()) { fail(res); return; }
    const employeeId = integerId(req.params.id);
    const {mimeType, processingAuthorizationConfirmed} = req.body ?? {};
    if (!employeeId || !validPhotoMime(mimeType) || processingAuthorizationConfirmed !== true) {
      res.status(400).json({message:"ID, format Pas Foto, atau persetujuan pemrosesan tidak valid."}); return;
    }
    const companyId = req.hrdCompanyId!;
    const actor = req.hrdActor!.email;
    const documentId = randomUUID();
    const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : "webp";
    const path = `${companyId}/${employeeId}/${documentId}.${ext}`;
    try {
      const signed = await withHrdCompanyScope(companyId, async (client) => {
        const employee = await client.query(
          "SELECT id FROM public.employees WHERE company_id=$1 AND id=$2 AND deleted_at IS NULL LIMIT 1",
          [companyId,employeeId],
        );
        if (employee.rowCount !== 1) return null;
        const authorization = await createHrdPhotoSignedUpload(path);
        await client.query(
          `INSERT INTO hrd_private.employee_documents
            (id,company_id,employee_id,doc_type,mime_type,storage_path,uploaded_by)
           VALUES ($1,$2,$3,'foto',$4,$5,$6)`,
          [documentId,companyId,employeeId,mimeType,path,actor],
        );
        await client.query(
          `INSERT INTO hrd_private.employee_document_audit
            (company_id,employee_id,document_id,action,actor)
           VALUES ($1,$2,$3,'prepared',$4)`,
          [companyId,employeeId,documentId,actor],
        );
        return authorization;
      });
      if (!signed) { res.status(404).json({message:"Karyawan tidak ditemukan."}); return; }
      res.setHeader("Cache-Control","no-store");
      res.status(201).json({companyId,employeeId,documentId,...signed,maxBytes:5242880});
    } catch (error) {
      req.log?.error?.({error,companyId,employeeId},"HRD private photo prepare failed");
      fail(res);
    }
  });

  router.post("/hrd/employees/:id/photo/:documentId/complete", async (req: HrdPhotoRequest,res: Response) => {
    if (!hrdPrivateStorageReady()) { fail(res); return; }
    const employeeId = integerId(req.params.id);
    const docId = req.params.documentId;
    if (!employeeId || !uuid(docId)) { res.status(400).json({message:"ID tidak valid."}); return; }
    const companyId = req.hrdCompanyId!;
    const actor = req.hrdActor!.email;
    try {
      const doc = await withHrdCompanyScope(companyId, async (client) => {
        const result = await client.query(
          `SELECT id,mime_type,storage_path FROM hrd_private.employee_documents
            WHERE id=$1 AND company_id=$2 AND employee_id=$3 AND doc_type='foto'
              AND status='upload_pending'`,
          [docId,companyId,employeeId],
        );
        return result.rows[0] as {mime_type:string;storage_path:string} | undefined;
      });
      if (!doc || !validPhotoMime(doc.mime_type)) { res.status(409).json({message:"Pas Foto tidak tersedia untuk diselesaikan."}); return; }
      const bytes = await readHrdPhoto(doc.storage_path);
      if (!validPhotoBytes(bytes,doc.mime_type)) {
        res.status(400).json({message:"Isi Pas Foto tidak sesuai format atau melebihi batas ukuran."}); return;
      }
      const hash = photoSha256(bytes);
      const done = await withHrdCompanyScope(companyId, async (client) => {
        const update = await client.query(
          `UPDATE hrd_private.employee_documents
             SET status='pending_review',original_sha256=$1,scanned_at=now(),updated_at=now()
           WHERE id=$2 AND company_id=$3 AND employee_id=$4
             AND doc_type='foto' AND status='upload_pending' RETURNING id`,
          [hash,docId,companyId,employeeId],
        );
        if (update.rowCount !== 1) return false;
        await client.query(
          `INSERT INTO hrd_private.employee_document_audit
            (company_id,employee_id,document_id,action,actor)
           VALUES ($1,$2,$3,'extracted',$4)`,
          [companyId,employeeId,docId,actor],
        );
        return true;
      });
      if (!done) { res.status(409).json({message:"Pas Foto sudah diproses."}); return; }
      res.setHeader("Cache-Control","no-store");
      res.json({companyId,employeeId,documentId:docId,status:"pending_review",requiresVerification:true,engine:"not_required"});
    } catch (error) {
      req.log?.error?.({error,companyId,employeeId},"HRD private photo complete failed"); fail(res);
    }
  });

  router.post("/hrd/employees/:id/photo/:documentId/verify", async (req: HrdPhotoRequest, res: Response) => {
    if (!hrdPrivateStorageReady()) { fail(res); return; }
    const employeeId = integerId(req.params.id);
    const docId = req.params.documentId;
    if (!employeeId || !uuid(docId) || req.body?.confirm !== true) {
      res.status(400).json({message:"Konfirmasi dan ID Pas Foto wajib valid."}); return;
    }
    const companyId = req.hrdCompanyId!;
    const actor = req.hrdActor!.email;
    try {
      const verified = await withHrdCompanyScope(companyId, async (client) => {
        const update = await client.query(
          `UPDATE hrd_private.employee_documents
             SET status='verified',verified_data='{}'::jsonb,verified_by=$1,
                 verified_at=now(),updated_at=now()
           WHERE id=$2 AND company_id=$3 AND employee_id=$4 AND doc_type='foto'
             AND status='pending_review' AND original_sha256 IS NOT NULL RETURNING id`,
          [actor,docId,companyId,employeeId],
        );
        if (update.rowCount !== 1) return false;
        await client.query(
          `INSERT INTO hrd_private.employee_document_audit
            (company_id,employee_id,document_id,action,actor,approved_data)
           VALUES ($1,$2,$3,'verified',$4,'{}'::jsonb)`,
          [companyId,employeeId,docId,actor],
        );
        return true;
      });
      if (!verified) { res.status(409).json({message:"Pas Foto tidak menunggu verifikasi."}); return; }
      res.json({companyId,employeeId,documentId:docId,status:"verified",legacyMasterUpdated:false});
    } catch (error) {
      req.log?.error?.({error,companyId,employeeId},"HRD photo verify failed"); fail(res);
    }
  });

  router.post("/hrd/employees/:id/photo/:documentId/preview", async (req: HrdPhotoRequest,res: Response) => {
    if (!hrdPrivateStorageReady()) { fail(res); return; }
    const employeeId=integerId(req.params.id),docId=req.params.documentId;
    if (!employeeId || !uuid(docId)) { res.status(400).json({message:"ID tidak valid."}); return; }
    const companyId=req.hrdCompanyId!;
    try {
      const path = await withHrdCompanyScope(companyId, async (client) => {
        const result=await client.query(
          `SELECT storage_path FROM hrd_private.employee_documents
           WHERE id=$1 AND company_id=$2 AND employee_id=$3
             AND doc_type='foto' AND status IN ('pending_review','verified')`,
          [docId,companyId,employeeId],
        );
        return result.rows[0]?.storage_path as string | undefined;
      });
      if (!path) { res.status(404).json({message:"Pas Foto tidak ditemukan."}); return; }
      const signed=await signHrdPhotoPreview(path);
      res.setHeader("Cache-Control","no-store");
      res.json(signed);
    } catch (error) {
      req.log?.error?.({error,companyId,employeeId},"HRD photo preview failed"); fail(res);
    }
  });
}
