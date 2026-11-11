import { Router, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getProductionSession, getProductionUser } from "./dev-auth";
import { authorizeHrdCompany } from "./hrd-access";
import { withHrdCompanyScope } from "./hrd-db";
import { registerHrdPhotoRoutes } from "./hrd-photo-routes";
import { registerHrdOcrRoutes } from "./hrd-ocr-routes";
import { hrdOcrReady } from "./hrd-document-ocr";
import { hrdPrivateStorageReady } from "./hrd-photo-storage";

type HrdRequest = Request & {
  hrdActor?: { id: string; email: string; role: string; companyId: number | null };
  hrdCompanyId?: number;
};
const router = Router();
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
      `SELECT 1 FROM public.users u
        WHERE lower(coalesce(to_jsonb(u)->>'email','')) = $1
          AND coalesce((to_jsonb(u)->>'is_active')::boolean,false) IS TRUE
          AND lower(coalesce(to_jsonb(u)->>'status','active')) = 'active'
        LIMIT 1`,
      [actor.email.trim().toLowerCase()],
    );
    if (active.rowCount !== 1) {
      res.status(403).json({ message: "Akses HRD akun nonaktif ditolak." }); return;
    }
    const companyId = authorizeHrdCompany(actor, req.query.companyId);
    if (companyId === null) { res.status(403).json({ message: "Akses HRD untuk perusahaan ini ditolak." }); return; }
    req.hrdActor = actor;
    req.hrdCompanyId = companyId;
    next();
  } catch (error) {
    req.log.error({ error }, "HRD production authorization failed");
    res.status(503).json({ message: "Otorisasi HRD tidak tersedia." });
  }
}
router.use(authorize);
registerHrdPhotoRoutes(router);
registerHrdOcrRoutes(router);

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
    res.json({ companyId, employeeId, ...data, canPay: false, photoUploadEnabled: hrdPrivateStorageReady(), ocrEnabled: hrdOcrReady() });
  } catch (error) {
    req.log.error({ error, companyId, employeeId }, "HRD employee detail read failed");
    res.status(503).json({ message: "Rincian HRD belum tersedia." });
  }
});

export default router;
