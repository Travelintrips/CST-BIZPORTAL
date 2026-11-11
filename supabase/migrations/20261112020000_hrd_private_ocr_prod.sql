-- CST BIZPORTAL PROD ONLY. Additive private HRD OCR storage.
-- Reuses existing least-privilege bizportal_payroll_prod capability role.
-- Does not update employee master, Payroll, salary, or payment records.
BEGIN;
DO $$
BEGIN
 IF current_database()<>'postgres' THEN RAISE EXCEPTION 'Unexpected PROD database'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='bizportal_payroll_prod' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit) THEN
  RAISE EXCEPTION 'Restricted bizportal_payroll_prod role missing or unsafe';
 END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS hrd_private;
REVOKE ALL ON SCHEMA hrd_private FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA hrd_private TO bizportal_payroll_prod;
CREATE TABLE IF NOT EXISTS hrd_private.employee_profiles(
 employee_id INTEGER PRIMARY KEY REFERENCES public.employees(id) ON DELETE RESTRICT,
 company_id INTEGER NOT NULL REFERENCES public.companies(id),
 verified_data JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(verified_data)='object'),
 updated_by TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hrd_employee_nik_company_unique
 ON hrd_private.employee_profiles(company_id,(verified_data->>'nik'))
 WHERE NULLIF(verified_data->>'nik','') IS NOT NULL;
CREATE TABLE IF NOT EXISTS hrd_private.employee_documents(
 id UUID PRIMARY KEY,
 employee_id INTEGER NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
 company_id INTEGER NOT NULL REFERENCES public.companies(id),
 doc_type TEXT NOT NULL CHECK(doc_type IN('ktp','kk','sim','npwp','ijazah','skck','foto','kontrak')),
 mime_type TEXT NOT NULL CHECK(mime_type IN('image/jpeg','image/png','image/webp','application/pdf')),
 storage_path TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'upload_pending' CHECK(status IN('upload_pending','scanning','pending_review','verified','rejected','scan_failed')),
 extracted_data JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(extracted_data)='object'),
 verified_data JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(verified_data)='object'),
 confidence NUMERIC(4,3) CHECK(confidence IS NULL OR(confidence>=0 AND confidence<=1)),
 warnings JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(warnings)='array'),
 original_sha256 TEXT,uploaded_by TEXT NOT NULL,verified_by TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),scanned_at TIMESTAMPTZ,verified_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(storage_path LIKE company_id::text||'/'||employee_id::text||'/%'),
 CHECK(verified_at IS NULL OR(status IN('verified','rejected') AND verified_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS employee_docs_company_employee_status_idx
 ON hrd_private.employee_documents(company_id,employee_id,status,created_at DESC);
CREATE TABLE IF NOT EXISTS hrd_private.employee_document_audit(
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 employee_id INTEGER NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
 company_id INTEGER NOT NULL REFERENCES public.companies(id),
 document_id UUID NOT NULL REFERENCES hrd_private.employee_documents(id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK(action IN('prepared','extracted','scan_failed','verified','rejected')),
 actor TEXT NOT NULL,changed_fields TEXT[] NOT NULL DEFAULT '{}'::text[],
 approved_data JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(approved_data)='object'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE hrd_private.employee_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hrd_private.employee_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE hrd_private.employee_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE hrd_private.employee_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE hrd_private.employee_document_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE hrd_private.employee_document_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hrd_prod_profiles_company_scope ON hrd_private.employee_profiles;
CREATE POLICY hrd_prod_profiles_company_scope ON hrd_private.employee_profiles FOR ALL TO bizportal_payroll_prod
 USING(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer)
 WITH CHECK(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer);
DROP POLICY IF EXISTS hrd_prod_documents_company_scope ON hrd_private.employee_documents;
CREATE POLICY hrd_prod_documents_company_scope ON hrd_private.employee_documents FOR ALL TO bizportal_payroll_prod
 USING(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer)
 WITH CHECK(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer);
DROP POLICY IF EXISTS hrd_prod_audit_select_scope ON hrd_private.employee_document_audit;
CREATE POLICY hrd_prod_audit_select_scope ON hrd_private.employee_document_audit FOR SELECT TO bizportal_payroll_prod
 USING(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer);
DROP POLICY IF EXISTS hrd_prod_audit_insert_scope ON hrd_private.employee_document_audit;
CREATE POLICY hrd_prod_audit_insert_scope ON hrd_private.employee_document_audit FOR INSERT TO bizportal_payroll_prod
 WITH CHECK(company_id=NULLIF(current_setting('app.payroll_company_id',true),'')::integer);
GRANT SELECT(id,first_name,last_name,status,email,phone,position,hire_date,deleted_at,company_id) ON public.employees TO bizportal_payroll_prod;
GRANT SELECT,INSERT,UPDATE ON hrd_private.employee_profiles,hrd_private.employee_documents TO bizportal_payroll_prod;
GRANT SELECT,INSERT ON hrd_private.employee_document_audit TO bizportal_payroll_prod;
GRANT USAGE,SELECT ON SEQUENCE hrd_private.employee_document_audit_id_seq TO bizportal_payroll_prod;
REVOKE ALL ON ALL TABLES IN SCHEMA hrd_private FROM PUBLIC,anon,authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA hrd_private FROM PUBLIC,anon,authenticated;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 VALUES('bizportal-hrd-documents-prod','bizportal-hrd-documents-prod',false,5242880,ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
 ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=5242880,allowed_mime_types=EXCLUDED.allowed_mime_types;
COMMIT;
