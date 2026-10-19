-- Release candidate: Mandiri QRIS per-payment MDR settlement effective 2026-10-01.
-- APPLY ONLY after DB-owner review and DEV integration tests. Never alter posted batches.
-- Merchant classification must be confirmed from acquirer. This patch is narrowly
-- limited to the owner-approved regular 0.7% Mandiri configuration, not all QRIS.
BEGIN;
DO $migration$
DECLARE
  function_name text;
  function_body text;
  replace_at text;
  policy_clause text := $policy$
    -- BI QRIS expanded zero-MDR threshold: calculate per *source payment*.
    -- Preserve posted source evidence. Refuse incomplete/stale candidate MDR.
    IF p_settlement_date >= DATE '2026-10-01'
       AND lower(btrim(p_provider_code)) = 'mandiri_direct'
       AND v_config.mdr_rate = 0.007
       AND v_config.source = 'OWNER_APPROVED'
       AND v_config.calculation_method = 'percentage_of_gross'
       AND coalesce(v_config.fixed_provider_fee,0) = 0
       AND coalesce(v_config.fee_tax_rate,0) = 0 THEN
      IF EXISTS (
        SELECT 1 FROM unnest(p_payment_ids) AS selected(payment_id)
        LEFT JOIN sport_center.sport_payments p ON p.id=selected.payment_id
        WHERE p.id IS NULL OR p.amount IS NULL OR p.amount <= 0
           OR p.mdr_amount IS NULL
           OR p.mdr_amount <> CASE WHEN p.amount <= 100000 THEN 0::numeric
                                  ELSE round(p.amount*0.007,2) END
      ) THEN
        RAISE EXCEPTION 'QRIS_MDR_SOURCE_REQUIRES_REVIEW: %',p_settlement_date;
      END IF;
      SELECT COALESCE(round(sum(p.mdr_amount)::numeric,2),0)
        INTO v_mdr
        FROM unnest(p_payment_ids) AS selected(payment_id)
        JOIN sport_center.sport_payments p ON p.id=selected.payment_id;
      v_total_deduction := v_mdr + coalesce(v_provider_fee,0) + coalesce(v_fee_tax,0);
      v_net := v_gross-v_total_deduction;
    END IF;
$policy$;
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'create_payment_settlement_batch_legacy',
    'create_payment_settlement_supplemental_batch'
  ] LOOP
    SELECT pg_get_functiondef(proc.oid) INTO function_body
    FROM pg_proc proc JOIN pg_namespace ns ON ns.oid=proc.pronamespace
    WHERE ns.nspname='sport_center' AND proc.proname=function_name;
    IF function_body IS NULL THEN
      RAISE EXCEPTION 'MISSING_SETTLEMENT_FUNCTION: %',function_name;
    END IF;
    IF position('QRIS_MDR_SOURCE_REQUIRES_REVIEW' IN function_body)>0 THEN
      RAISE EXCEPTION 'ALREADY_PATCHED_REVIEW_FIRST: %',function_name;
    END IF;
    replace_at := CASE function_name
      WHEN 'create_payment_settlement_batch_legacy' THEN '-- CREATE SETTLEMENT HEADER'
      ELSE 'SELECT COALESCE(MAX('
    END;
    IF position(replace_at IN function_body)=0 THEN
      RAISE EXCEPTION 'SETTLEMENT_ANCHOR_MISSING: %',function_name;
    END IF;
    function_body := replace(function_body,replace_at,policy_clause || E'\n' || replace_at);
    EXECUTE function_body;
  END LOOP;
END $migration$;
COMMIT;

[executed on device: srv1792369 (0891e23a-6a6b-4f8c-a16a-962e888e2014)]