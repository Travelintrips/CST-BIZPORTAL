-- Additive HRD resignation financial preflight.
-- No direct HRD SELECT grants on financial tables. Definer emits aggregates only.
-- This migration must be applied before enabling the new HRD resign runtime.
CREATE OR REPLACE FUNCTION hrd_private.employee_resign_kasbon_precheck(
  p_company_id integer,
  p_employee_id integer
)
RETURNS TABLE (
  unverified_count bigint,
  unverified_amount numeric,
  verified_unsettled_count bigint,
  verified_unsettled_amount numeric,
  active_reservations bigint,
  active_reservation_amount numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_scope integer;
BEGIN
  v_scope := NULLIF(current_setting('app.hrd_company_id',true),'')::integer;
  IF v_scope IS NULL OR v_scope<=0 OR v_scope IS DISTINCT FROM p_company_id
     OR p_employee_id IS NULL OR p_employee_id<=0 THEN
    RAISE EXCEPTION 'HRD_KASBON_SCOPE_INVALID' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.employees e WHERE e.id=p_employee_id
      AND e.company_id=v_scope AND e.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'HRD_KASBON_EMPLOYEE_NOT_FOUND' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  WITH unsettled AS (
    SELECT
      a.remaining_amount,
      -- Only a fully approved, disbursed, posted advance can be treated as a
      -- verified financial balance. DRAFT/PENDING are *not* confirmed debt.
      (
        lower(COALESCE(a.status,'')) NOT IN
          ('draft','void','rejected','cancelled','repaid')
        AND a.lifecycle_status IN ('outstanding','partially_settled','disbursed')
        AND a.approved_at IS NOT NULL
        AND NULLIF(btrim(a.approved_by),'') IS NOT NULL
        AND a.disbursed_at IS NOT NULL
        AND NULLIF(btrim(a.disbursed_by),'') IS NOT NULL
        AND a.accounting_entry_id IS NOT NULL
        AND lower(COALESCE(a.posting_status,''))='posted'
      ) AS verified
    FROM public.cash_advances a
    WHERE a.company_id=v_scope AND a.employee_id=p_employee_id
      AND a.type='kasbon' AND a.voided_at IS NULL
      AND COALESCE(a.remaining_amount,0)>0
  ),
  reservations AS (
    SELECT r.amount FROM public.payroll_kasbon_auto_reservations r
    WHERE r.company_id=v_scope AND r.employee_id=p_employee_id
      AND r.state IN ('prepared','confirmed')
  )
  SELECT
    (SELECT count(*) FROM unsettled u WHERE NOT u.verified),
    (SELECT COALESCE(sum(u.remaining_amount),0) FROM unsettled u WHERE NOT u.verified),
    (SELECT count(*) FROM unsettled u WHERE u.verified),
    (SELECT COALESCE(sum(u.remaining_amount),0) FROM unsettled u WHERE u.verified),
    (SELECT count(*) FROM reservations),
    (SELECT COALESCE(sum(r.amount),0) FROM reservations r);
END
$function$;

REVOKE ALL ON FUNCTION hrd_private.employee_resign_kasbon_precheck(integer,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION hrd_private.employee_resign_kasbon_precheck(integer,integer)
  TO bizportal_hrd_prod;
