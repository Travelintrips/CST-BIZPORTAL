import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getProductionSession, getProductionUser } from "./dev-auth";
import { authorizeHrdCompany } from "./hrd-access";
import { withHrdCompanyScope } from "./hrd-db";
import { registerHrdPhotoRoutes } from "./hrd-photo-routes";
import { registerHrdOcrRoutes } from "./hrd-ocr-routes";
import { registerHrdEmployeeStatusRoutes } from "./hrd-employee-status";
import { hrdOcrReady } from "./hrd-document-ocr";
import { hrdPrivateStorageReady, probeHrdPrivateStorage } from "./hrd-photo-storage";
import { runHrdStorageCanary } from "./hrd-storage-canary";

type HrdRequest = Request & {
  hrdActor?: { id: string; email: string; role: string; companyId: number | null };
  hrdCompanyId?: number;
};
const router = Router();
// Explicit DB identity of the designated CST owner. NOT a general Owner role grant.
// The ID comes from the existing public.users record for company 1.
const CST_HRD_OWNER_DB_USER_ID = "google_103728868378401731050";
const positiveId = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
};

/** Production-only session gate. Company selection is checked against the
 * server-side user record; query parameters never grant tenant membership. */
async function authorize(req: HrdRequest, res: Response, next: (error?: unknown) => void) {
  try {
    const session = getProductionSession(req);
    if (!session) { res.status(401).json({ message: "Sesi BizPortal tidak tersedia." }); return; }
    const actor = await getProductionUser(session);
    if (!actor) { res.status(403).json({ message: "Akun tidak aktif atau tidak terdaftar." }); return; }
    // The shared production session lookup establishes identity but does not
    // enforce status/is_active. HRD handles sensitive personal documents and
    // must independently reject disabled/revoked accounts.
    const active = await pool.query(
      `SELECT u.id::text AS db_user_id, u.company_id AS db_company_id, lower(btrim(u.role)) AS db_role FROM public.users u
        WHERE lower(coalesce(to_jsonb(u)->>'email','')) = $1
          AND coalesce((to_jsonb(u)->>'is_active')::boolean,false) IS TRUE
          AND lower(coalesce(to_jsonb(u)->>'status','active')) = 'active'
        LIMIT 1`,
      [actor.email.trim().toLowerCase()],
    );
    if (active.rowCount !== 1) {
      res.status(403).json({ message: "Akses HRD akun nonaktif ditolak." }); return;
    }
    const activeRecord = active.rows[0] as {
      db_user_id: string; db_company_id: number | null; db_role: string;
    };
    const cstOwnerHrdApproved =
      activeRecord.db_user_id === CST_HRD_OWNER_DB_USER_ID &&
      Number(activeRecord.db_company_id) === 1 &&
      activeRecord.db_role === "owner" &&
      actor.role.trim().toLowerCase() === "owner" &&
      actor.companyId === 1;
    const companyId = authorizeHrdCompany({...actor, cstOwnerHrdApproved}, req.query.companyId);
    if (companyId === null) { res.status(403).json({ message: "Akses HRD untuk perusahaan ini ditolak." }); return; }
    req.hrdActor = actor;
    req.hrdCompanyId = companyId;
    next();
  } catch (error) {
    req.log.error({ error }, "HRD production authorization failed");
    res.status(503).json({ message: "Otorisasi HRD tidak tersedia." });
  }
}
// An explicitly enabled release gate keeps all HRD routes dormant on a staged
// PROD code deployment. Authorization and OCR/storage flags remain independent.
router.use("/hrd", (req: HrdRequest, res: Response, next) => {
  // Read-only role readiness may run before HRD feature activation. Its
  // existing verified-session, active-account and verified HRD authorization checks still
  // apply below, and it never returns employee records or secrets.
  // All other HRD paths stay dormant until the explicit rollout flag is ON.
  if (process.env.HRD_PROD_ENABLED !== "true" &&
      !(req.method === "GET" && (req.path === "/readiness" || req.path === "/storage-readiness"))) {
    res.status(404).json({ message: "HRD belum diaktifkan." });
    return;
  }
  next();
});
router.use("/hrd", authorize);
registerHrdPhotoRoutes(router);
registerHrdOcrRoutes(router);
registerHrdEmployeeStatusRoutes(router);

// Safe authenticated readiness probe: prove the actual API database connection
// can SET LOCAL ROLE and access ONLY the selected tenant's employee directory.
// Does not reveal the runtime DB username, employee data, or secret settings.
router.get("/hrd/readiness", async (req: HrdRequest, res: Response) => {
  const companyId = req.hrdCompanyId!;
  try {
    const checked = await withHrdCompanyScope(companyId, async (client) => {
      const role = await client.query(
        "SELECT current_user AS current_role, current_setting('app.hrd_company_id',true) AS tenant_scope",
      );
      if (role.rows[0]?.current_role !== "bizportal_hrd_prod" ||
          role.rows[0]?.tenant_scope !== String(companyId)) {
        throw Error("HRD_DATABASE_ROLE_SCOPE_MISMATCH");
      }
      // The identity column is explicitly permitted and RLS filters this query.
      await client.query(
        "SELECT id FROM public.employees WHERE company_id=$1 AND deleted_at IS NULL LIMIT 1",
        [companyId],
      );
      return true;
    });
    res.setHeader("Cache-Control","no-store");
    res.json({ready:checked,companyId,roleIsolated:true});
  } catch (error) {
    req.log?.error?.({error,companyId},"HRD production role readiness failed");
    res.status(503).json({ready:false,message:"Koneksi database HRD belum dapat diverifikasi."});
  }
});

// Credential and bucket preflight. Safe when upload, OCR, and photos are OFF.
// Authenticated against the same company/role gate as employee reads.
router.get("/hrd/storage-readiness", async (req: HrdRequest, res: Response) => {
  res.setHeader("Cache-Control","no-store");
  const ready=await probeHrdPrivateStorage();
  res.status(ready?200:503).json({ready,companyId:req.hrdCompanyId,storagePrivate:ready});
});

// Disabled by default. One synthetic object, no employee/document DB writes.
// Requires the explicitly authorized CST Owner, same-origin POST and a one-shot intent.
let canaryConsumed=false;
router.post("/hrd/storage-canary", async (req: HrdRequest, res: Response) => {
  res.setHeader("Cache-Control","no-store");
  if (process.env.HRD_PROD_STORAGE_CANARY_ENABLED !== "true") {
    res.status(404).json({message:"Pemeriksaan sementara tidak aktif."}); return;
  }
  if (req.hrdCompanyId !== 1 || req.hrdActor?.role !== "owner" ||
      req.get("origin") !== "https://bizportal.cstlogistic.co.id" ||
      req.get("x-hrd-canary-intent") !== "synthetic-once") {
    res.status(403).json({message:"Pemeriksaan tidak diizinkan."}); return;
  }
  if (canaryConsumed) {
    res.status(409).json({message:"Pemeriksaan sudah dijalankan pada instance ini."}); return;
  }
  canaryConsumed=true;
  const result=await runHrdStorageCanary();
  res.status(result.ok?200:503).json({companyId:1,...result});
});

router.get("/hrd/employees", async (req: HrdRequest, res: Response) => {
  const companyId = req.hrdCompanyId!;
  try {
    const employees = await withHrdCompanyScope(companyId, async (client) => {
      const result = await client.query(
        `SELECT id, company_id, first_name, last_name, status, email, phone, position, hire_date
           FROM public.employees
          WHERE company_id = $1 AND deleted_at IS NULL
          ORDER BY first_name, last_name, id
          LIMIT 500`,
        [companyId],
      );
      return result.rows;
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ companyId, employees });
  } catch (error) {
    req.log.error({ error, companyId }, "HRD employee directory read failed");
    res.status(503).json({ message: "Direktori karyawan HRD belum tersedia." });
  }
});

router.get("/hrd/employees/:id", async (req: HrdRequest, res: Response) => {
  const companyId = req.hrdCompanyId!;
  const employeeId = positiveId(req.params.id);
  if (!employeeId) { res.status(400).json({ message: "ID karyawan tidak valid." }); return; }
  try {
    const data = await withHrdCompanyScope(companyId, async (client) => {
      const employee = await client.query(
        `SELECT id, company_id, first_name, last_name, status, email, phone, position, hire_date
           FROM public.employees
          WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [employeeId, companyId],
      );
      if (employee.rowCount !== 1) return null;
      const [profile, documents, audit] = await Promise.all([
        client.query(
          `SELECT verified_data, updated_by, updated_at
             FROM hrd_private.employee_profiles WHERE company_id=$1 AND employee_id=$2`,
          [companyId, employeeId],
        ),
        client.query(
          `SELECT id, doc_type, mime_type, status, extracted_data, verified_data,
                  confidence, warnings, created_at, scanned_at, verified_at
             FROM hrd_private.employee_documents
            WHERE company_id=$1 AND employee_id=$2
            ORDER BY created_at DESC LIMIT 80`,
          [companyId, employeeId],
        ),
        client.query(
          `SELECT document_id, action, actor, changed_fields, approved_data, created_at
             FROM hrd_private.employee_document_audit
            WHERE company_id=$1 AND employee_id=$2
            ORDER BY created_at DESC LIMIT 80`,
          [companyId, employeeId],
        ),
      ]);
      return {
        employee: employee.rows[0],
        verifiedProfile: profile.rows[0]?.verified_data ?? {},
        documents: documents.rows,
        audit: audit.rows,
      };
    });
    if (!data) { res.status(404).json({ message: "Karyawan tidak ditemukan di perusahaan aktif." }); return; }
    res.setHeader("Cache-Control", "no-store");
    res.json({ companyId, employeeId, ...data, canPay: false, statusChangeEnabled: process.env.APP_ENV?.trim().toLowerCase() === "production" && process.env.HRD_EMPLOYEE_STATUS_WRITE_ENABLED === "true", photoUploadEnabled: hrdPrivateStorageReady(), ocrEnabled: hrdOcrReady() });
  } catch (error) {
    req.log.error({ error, companyId, employeeId }, "HRD employee detail read failed");
    res.status(503).json({ message: "Rincian HRD belum tersedia." });
  }
});

export default router;
