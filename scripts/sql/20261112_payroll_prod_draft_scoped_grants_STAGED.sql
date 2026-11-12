-- STAGED ONLY / NOT APPLIED TO PROD.
-- Narrow Payroll PROD dedicated role privileges needed by source-verified
-- FULL/INSTALLMENT planning, read-only salary preview, and Draft materialization.
--
-- The role remains NOLOGIN; this script does NOT change login, authentication,
-- RLS policies, other companies, existing journals, payroll data or public grants.
-- Apply in a separately authorized, controlled release after staging tests pass.
DO $payroll_privileges$
DECLARE
  obj regclass;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bizportal_payroll_prod')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bizportal_payroll_prod_login')
  THEN RAISE EXCEPTION 'DEDICATED_PROD_PAYROLL_ROLES_MISSING'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname='bizportal_payroll_prod_login' AND rolcanlogin
  ) THEN RAISE EXCEPTION 'PROD_PAYROLL_LOGIN_MUST_REMAIN_DISABLED_AT_STAGING'; END IF;

  FOREACH obj IN ARRAY ARRAY[
    'public.employees'::regclass,'public.cash_advances'::regclass,
    'public.payroll_runs'::regclass,'public.payroll_items'::regclass,
    'public.payroll_salary_profiles'::regclass,'public.payroll_deduction_settings'::regclass,
    'public.payroll_kasbon_auto_plans'::regclass,
    'public.payroll_kasbon_auto_reservations'::regclass
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=obj AND relrowsecurity=true)
    THEN RAISE EXCEPTION 'REQUIRED_TABLE_RLS_NOT_ENABLED: %',obj; END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='payroll_runs'
      AND policyname='payroll_prod_run_insert_draft'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='payroll_items'
      AND policyname='payroll_prod_item_insert_draft'
  ) THEN RAISE EXCEPTION 'SCOPED_PROD_PAYROLL_INSERT_POLICIES_MISSING'; END IF;
END $payroll_privileges$;

-- The policies above already scope both tables by app.payroll_company_id,
-- active employee and Draft status. Do not grant UPDATE/DELETE on items or
-- cash advances; the actual settlement remains a separate, unenabled workflow.
GRANT INSERT ON TABLE public.payroll_runs,public.payroll_items TO bizportal_payroll_prod;

-- The dedicated role has existing row-level SELECT policies on these tables,
-- but no underlying table/column privileges. Grant *only* required fields.
GRANT SELECT (id,company_id,first_name,last_name,status,deleted_at)
  ON TABLE public.employees TO bizportal_payroll_prod;
GRANT SELECT (
  id,company_id,employee_id,type,status,lifecycle_status,currency,
  amount,paid_amount,settled_amount,remaining_amount,
  approved_at,approved_by,disbursed_at,disbursed_by,
  accounting_entry_id,posting_status,voided_at
) ON TABLE public.cash_advances TO bizportal_payroll_prod;

-- Existing grants on salary profiles, deductions, plans, reservations,
-- run/item reads and sequences are left unchanged. Explicitly no GRANT to
-- anon, authenticated, service_role or any public role.
