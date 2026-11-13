-- Additive, security-scoped permission for Payroll PROD read-only access using
-- the existing authenticated BizPortal database connection.
-- All SQL write paths remain blocked by the application and by BEGIN READ ONLY.
-- Do NOT grant to anon, authenticated, PUBLIC or the Payroll login role.
DO $payroll$
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'PAYROLL_EXPECTED_POSTGRES_DATABASE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname='bizportal_payroll_prod'
      AND rolcanlogin IS FALSE AND rolbypassrls IS FALSE
  ) THEN
    RAISE EXCEPTION 'PAYROLL_RESTRICTED_ROLE_NOT_READY';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='postgres' AND rolcanlogin IS TRUE) THEN
    RAISE EXCEPTION 'BIZPORTAL_POSTGRES_LOGIN_MISSING';
  END IF;
  -- In PostgreSQL 17, membership options are explicit:
  -- SET allows SET LOCAL ROLE within the transaction;
  -- INHERIT FALSE avoids silently inheriting Payroll privileges outside it;
  -- ADMIN FALSE prevents changing the grant.
  GRANT bizportal_payroll_prod TO postgres WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;
END
$payroll$;
