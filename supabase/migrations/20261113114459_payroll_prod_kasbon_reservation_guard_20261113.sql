-- Additive hardening after the already-applied 20261111164718 migration.
-- Does not change payroll, cash-advance, journal or salary-payment data.
-- The trigger is SECURITY DEFINER owned by the migration owner (postgres, BYPASSRLS)
-- so it can aggregate reservations on a FORCE-RLS table without policy recursion.
-- search_path is pinned and every application relation is schema-qualified.

DROP POLICY IF EXISTS payroll_prod_kasbon_plan_update
  ON public.payroll_kasbon_auto_plans;
CREATE POLICY payroll_prod_kasbon_plan_update
  ON public.payroll_kasbon_auto_plans
  FOR UPDATE TO bizportal_payroll_prod
  USING (
    company_id = NULLIF(current_setting('app.payroll_company_id',true),'')::integer
    AND NOT EXISTS (
      SELECT 1 FROM public.payroll_kasbon_auto_reservations r
      WHERE r.company_id=payroll_kasbon_auto_plans.company_id
        AND r.advance_id=payroll_kasbon_auto_plans.advance_id
        AND r.state IN ('prepared','confirmed')
    )
  )
  WITH CHECK (
    company_id = NULLIF(current_setting('app.payroll_company_id',true),'')::integer
    AND NOT EXISTS (
      SELECT 1 FROM public.payroll_kasbon_auto_reservations r
      WHERE r.company_id=payroll_kasbon_auto_plans.company_id
        AND r.advance_id=payroll_kasbon_auto_plans.advance_id
        AND r.state IN ('prepared','confirmed')
    )
    AND EXISTS (
      SELECT 1 FROM public.employees e
      WHERE e.id=payroll_kasbon_auto_plans.employee_id
        AND e.company_id=payroll_kasbon_auto_plans.company_id
        AND e.status='active' AND e.deleted_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM public.cash_advances a
      WHERE a.id=payroll_kasbon_auto_plans.advance_id
        AND a.employee_id=payroll_kasbon_auto_plans.employee_id
        AND a.company_id=payroll_kasbon_auto_plans.company_id
        AND a.type='kasbon'
    )
  );

DROP POLICY IF EXISTS payroll_prod_kasbon_reservation_insert
  ON public.payroll_kasbon_auto_reservations;
CREATE POLICY payroll_prod_kasbon_reservation_insert
  ON public.payroll_kasbon_auto_reservations
  FOR INSERT TO bizportal_payroll_prod
  WITH CHECK (
    company_id = NULLIF(current_setting('app.payroll_company_id',true),'')::integer
    AND state='prepared' AND confirmed_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.employees e
      WHERE e.id=payroll_kasbon_auto_reservations.employee_id
        AND e.company_id=payroll_kasbon_auto_reservations.company_id
        AND e.status='active' AND e.deleted_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM public.payroll_runs r
      WHERE r.id=payroll_kasbon_auto_reservations.run_id
        AND r.company_id=payroll_kasbon_auto_reservations.company_id
        AND r.status='draft'
        AND payroll_kasbon_auto_reservations.period=make_date(r.year,r.month,1)
    )
    AND EXISTS (
      SELECT 1 FROM public.payroll_items i
      WHERE i.id=payroll_kasbon_auto_reservations.payroll_item_id
        AND i.run_id=payroll_kasbon_auto_reservations.run_id
        AND i.employee_id=payroll_kasbon_auto_reservations.employee_id
        AND i.kasbon_deduction >= payroll_kasbon_auto_reservations.amount
    )
    AND EXISTS (
      SELECT 1 FROM public.cash_advances a
      WHERE a.id=payroll_kasbon_auto_reservations.advance_id
        AND a.employee_id=payroll_kasbon_auto_reservations.employee_id
        AND a.company_id=payroll_kasbon_auto_reservations.company_id
        AND a.type='kasbon'
        AND COALESCE(a.currency,'IDR')='IDR'
        AND a.status NOT IN ('draft','repaid','void','rejected','cancelled')
        AND a.lifecycle_status IN ('outstanding','partially_settled','disbursed')
        AND a.approved_at IS NOT NULL
        AND NULLIF(btrim(a.approved_by),'') IS NOT NULL
        AND a.disbursed_at IS NOT NULL
        AND NULLIF(btrim(a.disbursed_by),'') IS NOT NULL
        AND a.accounting_entry_id IS NOT NULL
        AND lower(COALESCE(a.posting_status,''))='posted'
        AND a.voided_at IS NULL
        AND a.remaining_amount=payroll_kasbon_auto_reservations.balance_at_preparation
        AND payroll_kasbon_auto_reservations.amount<=a.remaining_amount
    )
  );

CREATE OR REPLACE FUNCTION public.payroll_prod_validate_kasbon_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
AS $function$
DECLARE
  v_remaining NUMERIC(18,2);
  v_kasbon_deduction NUMERIC(18,2);
  v_month INTEGER;
  v_year INTEGER;
  v_existing NUMERIC(18,2);
BEGIN
  IF NEW.company_id IS DISTINCT FROM
      NULLIF(current_setting('app.payroll_company_id',true),'')::integer THEN
    RAISE EXCEPTION 'PAYROLL_KASBON_COMPANY_SCOPE_MISMATCH'
      USING ERRCODE='42501';
  END IF;

  SELECT a.remaining_amount
    INTO v_remaining
    FROM public.cash_advances a
   WHERE a.id=NEW.advance_id
     AND a.company_id=NEW.company_id
     AND a.employee_id=NEW.employee_id
     AND a.type='kasbon'
     AND COALESCE(a.currency,'IDR')='IDR'
     AND a.status NOT IN ('draft','repaid','void','rejected','cancelled')
     AND a.lifecycle_status IN ('outstanding','partially_settled','disbursed')
     AND a.approved_at IS NOT NULL
     AND NULLIF(btrim(a.approved_by),'') IS NOT NULL
     AND a.disbursed_at IS NOT NULL
     AND NULLIF(btrim(a.disbursed_by),'') IS NOT NULL
     AND a.accounting_entry_id IS NOT NULL
     AND lower(COALESCE(a.posting_status,''))='posted'
     AND a.voided_at IS NULL
   FOR SHARE;
  IF NOT FOUND OR v_remaining IS DISTINCT FROM NEW.balance_at_preparation
      OR NEW.amount > v_remaining THEN
    RAISE EXCEPTION 'PAYROLL_KASBON_SOURCE_NOT_CURRENT_AND_VERIFIED'
      USING ERRCODE='42501';
  END IF;

  SELECT r.month,r.year
    INTO v_month,v_year
    FROM public.payroll_runs r
   WHERE r.id=NEW.run_id
     AND r.company_id=NEW.company_id
     AND r.status='draft'
   FOR SHARE;
  IF NOT FOUND OR NEW.period IS DISTINCT FROM make_date(v_year,v_month,1) THEN
    RAISE EXCEPTION 'PAYROLL_KASBON_RESERVATION_PERIOD_MISMATCH'
      USING ERRCODE='42501';
  END IF;

  -- Serialize competing reservations for the same Payroll item.
  SELECT i.kasbon_deduction
    INTO v_kasbon_deduction
    FROM public.payroll_items i
   WHERE i.id=NEW.payroll_item_id
     AND i.run_id=NEW.run_id
     AND i.employee_id=NEW.employee_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYROLL_KASBON_ITEM_SCOPE_MISMATCH'
      USING ERRCODE='42501';
  END IF;

  SELECT COALESCE(sum(r.amount),0)
    INTO v_existing
    FROM public.payroll_kasbon_auto_reservations r
   WHERE r.company_id=NEW.company_id
     AND r.payroll_item_id=NEW.payroll_item_id
     AND r.state IN ('prepared','confirmed');
  IF v_existing + NEW.amount > v_kasbon_deduction THEN
    RAISE EXCEPTION 'PAYROLL_KASBON_RESERVATION_EXCEEDS_ITEM_DEDUCTION'
      USING ERRCODE='42501';
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.payroll_prod_validate_kasbon_reservation()
  FROM PUBLIC,anon,authenticated,bizportal_payroll_prod,bizportal_payroll_prod_login;
DROP TRIGGER IF EXISTS payroll_prod_validate_kasbon_reservation
  ON public.payroll_kasbon_auto_reservations;
CREATE TRIGGER payroll_prod_validate_kasbon_reservation
  BEFORE INSERT ON public.payroll_kasbon_auto_reservations
  FOR EACH ROW
  EXECUTE FUNCTION public.payroll_prod_validate_kasbon_reservation();
