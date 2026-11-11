-- PROD HRD only. Fix tenant-integrity trigger used by three private tables.
-- Prior implementation evaluated NEW.document_id for employee_profiles, which
-- has no document_id column. Separate the audit-only branch explicitly.
CREATE OR REPLACE FUNCTION hrd_private.enforce_employee_document_scope()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public, hrd_private
AS $hrd$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.employees e
     WHERE e.id=NEW.employee_id
       AND e.company_id=NEW.company_id
       AND e.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'HRD_EMPLOYEE_COMPANY_MISMATCH';
  END IF;

  IF TG_TABLE_NAME = 'employee_document_audit' THEN
    IF NOT EXISTS (
      SELECT 1 FROM hrd_private.employee_documents d
       WHERE d.id=NEW.document_id
         AND d.employee_id=NEW.employee_id
         AND d.company_id=NEW.company_id
    ) THEN
      RAISE EXCEPTION 'HRD_AUDIT_DOCUMENT_COMPANY_MISMATCH';
    END IF;
  END IF;
  RETURN NEW;
END
$hrd$;

REVOKE ALL ON FUNCTION hrd_private.enforce_employee_document_scope()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION hrd_private.enforce_employee_document_scope()
  TO bizportal_hrd_prod;
