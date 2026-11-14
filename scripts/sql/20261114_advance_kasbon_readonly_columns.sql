-- Additive SELECT-only columns on the existing least-privilege Payroll reader.
-- Existing payroll RLS limits cash_advances to the scoped company and type='kasbon'.
-- Does not grant any INSERT/UPDATE/DELETE, does not alter RLS or financial data.
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cash_advances'
      AND policyname='payroll_prod_cash_advance_read'
      AND cmd='SELECT'
  ) THEN
    RAISE EXCEPTION 'PAYROLL_KASBON_RLS_POLICY_MISSING';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname='bizportal_payroll_prod'
      AND rolcanlogin=FALSE AND rolbypassrls=FALSE
  ) THEN
    RAISE EXCEPTION 'PAYROLL_ROLE_NOT_ISOLATED';
  END IF;
END $guard$;
GRANT SELECT (advance_number,date) ON public.cash_advances TO bizportal_payroll_prod;
