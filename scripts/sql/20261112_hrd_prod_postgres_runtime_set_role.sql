-- CST-BIZPORTAL PROD / HRD ONLY
-- Follow-up to applied migration hrd_private_hybrid_ocr_prod_20261112.
-- The application may resolve its shared production database credentials
-- through Supabase's postgres login rather than bizportal_prod. Its existing
-- privileges remain unchanged: this membership does NOT inherit the HRD role.
-- Only SET LOCAL ROLE within an authenticated, company-scoped transaction
-- makes the private HRD policies usable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bizportal_hrd_prod'
                 AND NOT rolcanlogin AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'HRD_ROLE_NOT_PRESENT_OR_UNSAFE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN
    RAISE EXCEPTION 'PROD_RUNTIME_ROLE_NOT_PRESENT';
  END IF;
END
$$;

GRANT bizportal_hrd_prod TO postgres WITH INHERIT FALSE, SET TRUE;

DO $$
BEGIN
  IF NOT pg_has_role('postgres','bizportal_hrd_prod','SET')
     OR pg_has_role('postgres','bizportal_hrd_prod','USAGE') THEN
    RAISE EXCEPTION 'HRD_POSTGRES_SET_ONLY_ROLE_NOT_ENFORCED';
  END IF;
END
$$;

-- Never grant this role to anon/authenticated/service_role.
-- Never change existing application/Payroll/SC RLS policies in this migration.
