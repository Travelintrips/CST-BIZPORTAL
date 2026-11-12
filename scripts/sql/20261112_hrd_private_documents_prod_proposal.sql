-- PRODUCTION HRD PRIVATE DOCUMENTS — PROPOSAL ONLY.
-- Do NOT apply until the matching API code explicitly performs:
--   BEGIN; SET LOCAL ROLE bizportal_hrd_prod;
--   SELECT set_config('app.hrd_company_id', '<verified session company>', true);
-- All application SQL must include company_id predicates as defense in depth.
-- This role is non-login, non-superuser and cannot bypass RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bizportal_hrd_prod') THEN
    CREATE ROLE bizportal_hrd_prod NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

-- The existing application login has no BYPASSRLS. Membership is explicitly
-- non-inheriting: backend must SET LOCAL ROLE inside each HRD transaction.
-- Never expose the role to anon/authenticated or browser clients.
GRANT bizportal_hrd_prod TO bizportal_prod WITH INHERIT FALSE, SET TRUE;
DO $$
DECLARE r RECORD;
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    INTO r FROM pg_roles WHERE rolname = 'bizportal_hrd_prod';
  IF NOT FOUND OR r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
     OR r.rolreplication OR r.rolbypassrls THEN
    RAISE EXCEPTION 'HRD_PROD_ROLE_SECURITY_DRIFT';
  END IF;
  IF NOT pg_has_role('bizportal_prod','bizportal_hrd_prod','MEMBER') THEN
    RAISE EXCEPTION 'HRD_PROD_ROLE_MEMBERSHIP_MISSING';
  END IF;
END
$$;

-- The HRD role reads only the employee directory columns needed by the HRD
-- screen. This is a separate RLS policy; the existing anon/authenticated
-- deny-all and Payroll policy remain untouched.
GRANT SELECT (id, company_id, first_name, last_name, status, email, phone, position, hire_date, deleted_at)
  ON public.employees TO bizportal_hrd_prod;
DROP POLICY IF EXISTS hrd_prod_employee_directory_read ON public.employees;
CREATE POLICY hrd_prod_employee_directory_read ON public.employees
  FOR SELECT TO bizportal_hrd_prod
  USING (company_id = NULLIF(current_setting('app.hrd_company_id', true),'')::INTEGER);

CREATE SCHEMA IF NOT EXISTS hrd_private;
REVOKE ALL ON SCHEMA hrd_private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA hrd_private TO bizportal_hrd_prod;

CREATE TABLE IF NOT EXISTS hrd_private.employee_profiles (
  company_id INTEGER NOT NULL REFERENCES public.companies(id),
  employee_id INTEGER NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  verified_data JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(verified_data) = 'object'),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, employee_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS hrd_employee_nik_company_unique
  ON hrd_private.employee_profiles(company_id, (verified_data->>'nik'))
  WHERE NULLIF(verified_data->>'nik','') IS NOT NULL;

CREATE TABLE IF NOT EXISTS hrd_private.employee_documents (
  id UUID PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES public.companies(id),
  employee_id INTEGER NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('ktp','kk','sim','npwp','ijazah','skck','foto','kontrak')),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
  storage_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'upload_pending'
    CHECK (status IN ('upload_pending','scanning','pending_review','verified','rejected','scan_failed')),
  extracted_data JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(extracted_data) = 'object'),
  verified_data JSONB CHECK (verified_data IS NULL OR jsonb_typeof(verified_data) = 'object'),
  confidence NUMERIC(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array'),
  original_sha256 TEXT,
  uploaded_by TEXT NOT NULL,
  verified_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scanned_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (storage_path LIKE company_id::text || '/' || employee_id::text || '/%'),
  CHECK (verified_at IS NULL OR (status IN ('verified','rejected') AND verified_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS employee_docs_company_employee_status_idx
  ON hrd_private.employee_documents(company_id, employee_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS hrd_private.employee_document_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES public.companies(id),
  employee_id INTEGER NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  document_id UUID NOT NULL REFERENCES hrd_private.employee_documents(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('prepared','extracted','scan_failed','verified','rejected')),
  actor TEXT NOT NULL,
  changed_fields TEXT[] NOT NULL DEFAULT '{}'::text[],
  approved_data JSONB CHECK (approved_data IS NULL OR jsonb_typeof(approved_data) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS employee_document_audit_company_employee_idx
  ON hrd_private.employee_document_audit(company_id, employee_id, created_at DESC);

-- An employee ID alone is not a tenant boundary. Enforce its company match
-- in the database as well as in the API. Prevent audit records from pointing
-- to a document belonging to another employee/company.
CREATE OR REPLACE FUNCTION hrd_private.enforce_employee_document_scope()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, hrd_private
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.employees e
    WHERE e.id=NEW.employee_id AND e.company_id=NEW.company_id
      AND e.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'HRD_EMPLOYEE_COMPANY_MISMATCH';
  END IF;
  IF TG_TABLE_NAME='employee_document_audit' AND NOT EXISTS (
    SELECT 1 FROM hrd_private.employee_documents d
    WHERE d.id=NEW.document_id
      AND d.employee_id=NEW.employee_id
      AND d.company_id=NEW.company_id
  ) THEN
    RAISE EXCEPTION 'HRD_AUDIT_DOCUMENT_COMPANY_MISMATCH';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION hrd_private.enforce_employee_document_scope()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION hrd_private.enforce_employee_document_scope()
  TO bizportal_hrd_prod;
DROP TRIGGER IF EXISTS hrd_profiles_employee_scope ON hrd_private.employee_profiles;
CREATE TRIGGER hrd_profiles_employee_scope
  BEFORE INSERT OR UPDATE ON hrd_private.employee_profiles
  FOR EACH ROW EXECUTE FUNCTION hrd_private.enforce_employee_document_scope();
DROP TRIGGER IF EXISTS hrd_docs_employee_scope ON hrd_private.employee_documents;
CREATE TRIGGER hrd_docs_employee_scope
  BEFORE INSERT OR UPDATE ON hrd_private.employee_documents
  FOR EACH ROW EXECUTE FUNCTION hrd_private.enforce_employee_document_scope();
DROP TRIGGER IF EXISTS hrd_audit_employee_scope ON hrd_private.employee_document_audit;
CREATE TRIGGER hrd_audit_employee_scope
  BEFORE INSERT OR UPDATE ON hrd_private.employee_document_audit
  FOR EACH ROW EXECUTE FUNCTION hrd_private.enforce_employee_document_scope();

ALTER TABLE hrd_private.employee_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE hrd_private.employee_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE hrd_private.employee_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE hrd_private.employee_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE hrd_private.employee_document_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE hrd_private.employee_document_audit FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hrd_profiles_company_scope ON hrd_private.employee_profiles;
CREATE POLICY hrd_profiles_company_scope ON hrd_private.employee_profiles
  FOR ALL TO bizportal_hrd_prod
  USING (company_id = NULLIF(current_setting('app.hrd_company_id', true),'')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.hrd_company_id', true),'')::INTEGER);
DROP POLICY IF EXISTS hrd_documents_company_scope ON hrd_private.employee_documents;
CREATE POLICY hrd_documents_company_scope ON hrd_private.employee_documents
  FOR ALL TO bizportal_hrd_prod
  USING (company_id = NULLIF(current_setting('app.hrd_company_id', true),'')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.hrd_company_id', true),'')::INTEGER);
DROP POLICY IF EXISTS hrd_audit_company_scope ON hrd_private.employee_document_audit;
CREATE POLICY hrd_audit_company_scope ON hrd_private.employee_document_audit
  FOR ALL TO bizportal_hrd_prod
  USING (company_id = NULLIF(current_setting('app.hrd_company_id', true),'')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.hrd_company_id', true),'')::INTEGER);

REVOKE ALL ON ALL TABLES IN SCHEMA hrd_private FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA hrd_private FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON hrd_private.employee_profiles TO bizportal_hrd_prod;
GRANT SELECT, INSERT, UPDATE ON hrd_private.employee_documents TO bizportal_hrd_prod;
GRANT SELECT, INSERT ON hrd_private.employee_document_audit TO bizportal_hrd_prod;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA hrd_private TO bizportal_hrd_prod;

-- Private bucket. No storage.objects policies are added for browser roles.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('bizportal-hrd-documents-prod','bizportal-hrd-documents-prod',false,5242880,
  ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- Required verification after implementation:
-- 1) SET LOCAL ROLE bizportal_hrd_prod + company_id=1 can access only company 1.
-- 2) company_id=3 can access only company 3, not company 1.
-- 3) missing/invalid company scope returns zero rows and rejects writes.
-- 4) anon/authenticated/service_role have no schema/table privileges or storage policies; existing employee deny-all policies remain intact.
-- 5) verify bucket remains private and signed URLs expire.
-- This proposal has not been applied to PROD.
