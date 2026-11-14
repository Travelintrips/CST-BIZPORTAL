-- Additive HRD employee resignation transition, status column only.
-- No deletes, no financial writes, no changes to existing Payroll history.
DO $guard$
BEGIN
  IF current_database()<>'postgres' THEN RAISE EXCEPTION 'HRD_PROD_DATABASE_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bizportal_hrd_prod'
                 AND rolcanlogin IS FALSE AND rolbypassrls IS FALSE)
    THEN RAISE EXCEPTION 'HRD_ROLE_NOT_SAFE'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='employees' AND policyname='hrd_prod_employee_directory_read')
    THEN RAISE EXCEPTION 'HRD_EMPLOYEE_READ_POLICY_MISSING'; END IF;
END $guard$;

CREATE TABLE IF NOT EXISTS hrd_private.employee_status_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 company_id integer NOT NULL REFERENCES public.companies(id),
 employee_id integer NOT NULL REFERENCES public.employees(id),
 previous_status text NOT NULL CHECK (previous_status='active'),
 new_status text NOT NULL CHECK (new_status='inactive'),
 reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 10 AND 500),
 actor_email text NOT NULL CHECK (char_length(btrim(actor_email)) BETWEEN 3 AND 254),
 changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hrd_status_audit_company_employee
 ON hrd_private.employee_status_audit (company_id,employee_id,changed_at DESC,id DESC);

ALTER TABLE hrd_private.employee_status_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE hrd_private.employee_status_audit FORCE ROW LEVEL SECURITY;
REVOKE ALL ON hrd_private.employee_status_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT ON hrd_private.employee_status_audit TO bizportal_hrd_prod;

DROP POLICY IF EXISTS hrd_status_audit_read_company ON hrd_private.employee_status_audit;
CREATE POLICY hrd_status_audit_read_company ON hrd_private.employee_status_audit
 FOR SELECT TO bizportal_hrd_prod
 USING (company_id = NULLIF(current_setting('app.hrd_company_id',true),'')::integer);

DROP POLICY IF EXISTS hrd_status_audit_insert_company ON hrd_private.employee_status_audit;
CREATE POLICY hrd_status_audit_insert_company ON hrd_private.employee_status_audit
 FOR INSERT TO bizportal_hrd_prod
 WITH CHECK (company_id = NULLIF(current_setting('app.hrd_company_id',true),'')::integer
             AND previous_status='active' AND new_status='inactive');

-- Explicit column-only UPDATE; no blanket UPDATE rights on employees.
GRANT UPDATE(status) ON public.employees TO bizportal_hrd_prod;
DROP POLICY IF EXISTS hrd_prod_employee_resign_status_only ON public.employees;
CREATE POLICY hrd_prod_employee_resign_status_only ON public.employees
 FOR UPDATE TO bizportal_hrd_prod
 USING (company_id = NULLIF(current_setting('app.hrd_company_id',true),'')::integer
        AND deleted_at IS NULL AND status='active')
 WITH CHECK (company_id = NULLIF(current_setting('app.hrd_company_id',true),'')::integer
             AND deleted_at IS NULL AND status='inactive');
