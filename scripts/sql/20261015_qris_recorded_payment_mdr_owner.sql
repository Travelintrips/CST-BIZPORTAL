-- Canonical QRIS settlement: prevent overcharging zero-MDR payments.
-- Production gate: verified bank/provider evidence, tests, controlled release.
-- Expected original owner-function MD5 from read-only DEV/PROD catalog: 92e78f9120966df50f9f53e381fc868a
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '90s';
DO $mdr_guard$
DECLARE actual_hash text;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO actual_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='sport_center'
     AND p.proname='create_payment_settlement_batch_legacy';
  IF actual_hash IS DISTINCT FROM '92e78f9120966df50f9f53e381fc868a' THEN
    RAISE EXCEPTION 'CANONICAL_SETTLEMENT_OWNER_DRIFT: %', actual_hash;
  END IF;
END $mdr_guard$;

CREATE OR REPLACE FUNCTION sport_center.create_payment_settlement_batch_legacy(p_settlement_reference text, p_company_id integer, p_provider_code text, p_bank_account_id text, p_settlement_date date, p_payment_ids integer[], p_actor text DEFAULT 'manual-supabase'::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
DECLARE

    v_config
        sport_center.payment_settlement_configs%ROWTYPE;

    v_existing_batch_id bigint;

    v_batch_id bigint;

    v_input_count integer;
    v_unique_count integer;

    v_valid_count integer;

    v_gross numeric(18,2);

    v_effective_mdr_rate numeric;
    v_effective_fixed_fee numeric;

    v_mdr numeric(18,2);
    v_recorded_mdr numeric(18,2);
    v_recorded_mdr_count integer;
    v_provider_fee numeric(18,2);
    v_fee_tax numeric(18,2);
    v_total_deduction numeric(18,2);
    v_net numeric(18,2);

    v_rule_version text;

BEGIN

    -- ========================================================
    -- INPUT VALIDATION
    -- ========================================================

    IF p_settlement_reference IS NULL
       OR btrim(p_settlement_reference) = '' THEN

        RAISE EXCEPTION
            'SETTLEMENT_REFERENCE_REQUIRED';

    END IF;


    IF p_company_id IS NULL THEN
        RAISE EXCEPTION
            'COMPANY_ID_REQUIRED';
    END IF;


    IF p_provider_code IS NULL
       OR btrim(p_provider_code) = '' THEN

        RAISE EXCEPTION
            'PROVIDER_CODE_REQUIRED';

    END IF;


    IF p_bank_account_id IS NULL
       OR btrim(p_bank_account_id) = '' THEN

        RAISE EXCEPTION
            'BANK_ACCOUNT_REQUIRED';

    END IF;


    IF p_settlement_date IS NULL THEN
        RAISE EXCEPTION
            'SETTLEMENT_DATE_REQUIRED';
    END IF;


    IF p_payment_ids IS NULL
       OR cardinality(p_payment_ids) = 0 THEN

        RAISE EXCEPTION
            'PAYMENT_IDS_REQUIRED';

    END IF;


    -- --------------------------------------------------------
    -- Reject NULL payment IDs.
    -- --------------------------------------------------------

    IF EXISTS (
        SELECT 1
        FROM unnest(p_payment_ids) x(payment_id)
        WHERE payment_id IS NULL
    ) THEN

        RAISE EXCEPTION
            'NULL_PAYMENT_ID_NOT_ALLOWED';

    END IF;


    -- --------------------------------------------------------
    -- Reject duplicate IDs in input itself.
    -- --------------------------------------------------------

    v_input_count :=
        cardinality(p_payment_ids);


    SELECT COUNT(DISTINCT x.payment_id)
      INTO v_unique_count
      FROM unnest(p_payment_ids) x(payment_id);


    IF v_input_count <> v_unique_count THEN

        RAISE EXCEPTION
            'DUPLICATE_PAYMENT_ID_IN_REQUEST';

    END IF;


    -- ========================================================
    -- SERIALIZE SAME SETTLEMENT REFERENCE
    -- ========================================================

    PERFORM pg_advisory_xact_lock(
        hashtext(
            p_company_id::text
            || '|'
            || lower(p_provider_code)
            || '|'
            || p_settlement_reference
        )
    );


    -- ========================================================
    -- IDEMPOTENT RETRY
    --
    -- If same settlement reference already exists,
    -- return it instead of creating another one.
    -- ========================================================

    SELECT id
      INTO v_existing_batch_id
      FROM sport_center.payment_settlement_batches
     WHERE company_id = p_company_id
       AND lower(provider_code) =
           lower(p_provider_code)
       AND settlement_reference =
           p_settlement_reference
     LIMIT 1;


    IF v_existing_batch_id IS NOT NULL THEN

        -- Ensure retry is requesting exactly the same payments.

        IF (
            SELECT COUNT(*)
            FROM sport_center.payment_settlement_items i
            WHERE i.settlement_id = v_existing_batch_id
              AND i.item_status = 'active'
        ) <> v_input_count
        THEN

            RAISE EXCEPTION
                'SETTLEMENT_REFERENCE_ALREADY_EXISTS_WITH_DIFFERENT_ITEMS: %',
                v_existing_batch_id;

        END IF;


        IF EXISTS (
            SELECT 1
            FROM unnest(p_payment_ids) x(payment_id)
            WHERE NOT EXISTS (
                SELECT 1
                FROM sport_center.payment_settlement_items i
                WHERE i.settlement_id =
                    v_existing_batch_id
                  AND i.payment_id =
                    x.payment_id
                  AND i.item_status =
                    'active'
            )
        ) THEN

            RAISE EXCEPTION
                'SETTLEMENT_REFERENCE_ALREADY_EXISTS_WITH_DIFFERENT_PAYMENTS: %',
                v_existing_batch_id;

        END IF;


        RETURN v_existing_batch_id;

    END IF;


    -- ========================================================
    -- VALIDATE EVERY PAYMENT
    --
    -- Requirements:
    --
    -- confirmed
    -- posted internal payment journal
    -- correct company/provider/bank
    -- non-reversal
    -- not already settled
    -- ========================================================

    SELECT COUNT(*)
      INTO v_valid_count

      FROM unnest(p_payment_ids) x(payment_id)

      JOIN sport_center.sport_payments p
        ON p.id = x.payment_id

      JOIN sport_center.accounting_journals j
        ON j.payment_id = p.id
       AND j.journal_type = 'payment_confirmed'
       AND j.is_reversal = false
       AND j.status = 'posted'

     WHERE p.status::text = 'confirmed'

       AND p.company_id = p_company_id

       AND lower(
            COALESCE(
                p.payment_provider::text,
                ''
            )
       ) = lower(p_provider_code)

       AND p.bank_account_id =
           p_bank_account_id

       AND NOT EXISTS (
            SELECT 1
            FROM sport_center.payment_settlement_items si
            WHERE si.payment_id = p.id
              AND si.item_status = 'active'
       );


    IF v_valid_count <> v_input_count THEN

        RAISE EXCEPTION
            'ONE_OR_MORE_PAYMENTS_NOT_ELIGIBLE: requested=% eligible=%',
            v_input_count,
            v_valid_count;

    END IF;


    -- ========================================================
    -- CALCULATE GROSS FROM POSTED JOURNAL
    --
    -- Journal is source of accounting truth.
    -- Do not calculate revenue/PPN again.
    -- ========================================================

    SELECT ROUND(
        SUM(j.gross_amount + COALESCE((
          SELECT SUM(CASE WHEN c.is_reversal THEN -c.gross_amount ELSE c.gross_amount END)
          FROM sport_center.accounting_journals c
          WHERE c.payment_id = j.payment_id
            AND c.journal_type = 'payment_amount_correction'
            AND c.status = 'posted'
            AND c.reversal_of_id = j.id
        ), 0))::numeric,
        2
    )
      INTO v_gross

      FROM unnest(p_payment_ids) x(payment_id)

      JOIN sport_center.accounting_journals j
        ON j.payment_id = x.payment_id
       AND j.journal_type = 'payment_confirmed'
       AND j.is_reversal = false
       AND j.status = 'posted';


    IF v_gross IS NULL OR v_gross <= 0 THEN

        RAISE EXCEPTION
            'INVALID_SETTLEMENT_GROSS';

    END IF;


    -- ========================================================
    -- RESOLVE PRODUCTION CONFIG
    --
    -- Never falls back to UAT configuration.
    -- ========================================================

    SELECT *
      INTO v_config
      FROM sport_center.resolve_payment_settlement_config(
            p_company_id,
            p_provider_code,
            p_bank_account_id,
            p_settlement_date
      );


    v_rule_version :=
        COALESCE(
            v_config.rule_version,
            'config-' || v_config.id::text
        );


    -- ========================================================
    -- CALCULATION METHOD
    -- ========================================================

    CASE v_config.calculation_method

        WHEN 'percentage_of_gross' THEN

            v_effective_mdr_rate :=
                v_config.mdr_rate;

            v_effective_fixed_fee :=
                0;


        WHEN 'fixed_fee' THEN

            v_effective_mdr_rate :=
                0;

            v_effective_fixed_fee :=
                v_config.fixed_provider_fee;


        WHEN 'percentage_plus_fixed' THEN

            v_effective_mdr_rate :=
                v_config.mdr_rate;

            v_effective_fixed_fee :=
                v_config.fixed_provider_fee;


        ELSE

            RAISE EXCEPTION
                'UNSUPPORTED_SETTLEMENT_CALCULATION_METHOD: %',
                v_config.calculation_method;

    END CASE;


    -- ========================================================
    -- CALCULATE MDR / PROVIDER FEE / NET
    -- Only the audited Mandiri QRIS cohort of 7-9 October 2026 uses
    -- the source payment MDR (including explicit zero). All other
    -- settlements retain the previous owner-function calculation.
    -- Source discrepancies must be corrected with provider evidence.
    -- ========================================================
    IF p_company_id = 1
       AND lower(btrim(p_provider_code)) = 'mandiri_direct'
       AND btrim(p_bank_account_id) = '1640006707220'
       AND p_settlement_date BETWEEN DATE '2026-10-07' AND DATE '2026-10-09'
    THEN
      IF v_config.calculation_method <> 'percentage_of_gross'
         OR v_config.mdr_rate IS DISTINCT FROM 0.007 THEN
        RAISE EXCEPTION 'CANONICAL_SETTLEMENT_PROVIDER_RULE_DRIFT';
      END IF;

    SELECT COUNT(*) FILTER (WHERE p.mdr_amount IS NOT NULL)::integer,
           ROUND(COALESCE(SUM(p.mdr_amount),0)::numeric,2)
      INTO v_recorded_mdr_count, v_recorded_mdr
      FROM unnest(p_payment_ids) x(payment_id)
      JOIN sport_center.sport_payments p ON p.id=x.payment_id;

    IF v_recorded_mdr_count NOT IN (0,v_input_count) THEN
      RAISE EXCEPTION 'CANONICAL_SETTLEMENT_PARTIAL_MDR_EVIDENCE';
    END IF;

    IF v_recorded_mdr_count = v_input_count THEN
      IF v_recorded_mdr < 0 OR v_recorded_mdr > v_gross THEN
        RAISE EXCEPTION 'CANONICAL_SETTLEMENT_RECORDED_MDR_INVALID';
      END IF;
      IF v_config.calculation_method = 'fixed_fee'
         AND v_recorded_mdr <> 0 THEN
        RAISE EXCEPTION 'CANONICAL_SETTLEMENT_FIXED_FEE_MDR_CONFLICT';
      END IF;
      v_effective_mdr_rate := v_recorded_mdr / v_gross;
    END IF;
    END IF;

    SELECT c.base_mdr_amount, c.provider_fee_amount, c.fee_tax_amount,
           c.total_deduction, c.net_amount
      INTO v_mdr, v_provider_fee, v_fee_tax, v_total_deduction, v_net
      FROM sport_center.calculate_settlement_mdr(
        v_gross, v_effective_mdr_rate, v_effective_fixed_fee,
        v_config.fee_tax_rate, v_config.fee_tax_inclusive,
        v_config.rounding_scale, v_config.rounding_method
      ) c;

    IF v_recorded_mdr_count = v_input_count
       AND v_mdr IS DISTINCT FROM v_recorded_mdr THEN
      RAISE EXCEPTION 'CANONICAL_SETTLEMENT_RECORDED_MDR_ROUNDING_MISMATCH';
    END IF;


    -- ========================================================
    -- CREATE SETTLEMENT HEADER
    --
    -- status = calculated
    --
    -- NOT posted.
    -- NOT reconciled.
    -- ========================================================

    INSERT INTO
    sport_center.payment_settlement_batches
    (
        settlement_reference,

        company_id,

        provider_code,
        provider_name,

        bank_account_id,

        settlement_date,

        gross_amount,
        mdr_amount,
        provider_fee_amount,
        fee_tax_amount,
        tax_withheld_amount,
        adjustment_amount,
        net_amount,

        status,

        calculated_at,
        calculated_by,

        settlement_rule_version,

        source,
        correlation_id,

        created_by
    )
    VALUES
    (
        p_settlement_reference,

        p_company_id,

        lower(p_provider_code),
        lower(p_provider_code),

        p_bank_account_id,

        p_settlement_date,

        v_gross,
        v_mdr,
        v_provider_fee,
        v_fee_tax,
        0,
        0,
        v_net,

        'calculated',

        now(),
        p_actor,

        v_rule_version,

        'SPORT_CENTER',

        'sc_settlement_'
            || p_company_id::text
            || '_'
            || lower(p_provider_code)
            || '_'
            || p_settlement_reference,

        p_actor
    )
    RETURNING id
      INTO v_batch_id;


    -- ========================================================
    -- CREATE SETTLEMENT ITEMS
    --
    -- Gross contribution only.
    --
    -- NO MDR allocation per payment.
    -- ========================================================

    INSERT INTO
    sport_center.payment_settlement_items
    (
        settlement_id,

        payment_id,

        payment_journal_id,

        gross_amount,

        item_status,

        source_event_id,
        correlation_id,

        created_by
    )

    SELECT
        v_batch_id,

        p.id,

        j.id,        j.gross_amount + COALESCE((
          SELECT SUM(CASE WHEN c.is_reversal THEN -c.gross_amount ELSE c.gross_amount END)
          FROM sport_center.accounting_journals c
          WHERE c.payment_id = j.payment_id
            AND c.journal_type = 'payment_amount_correction'
            AND c.status = 'posted'
            AND c.reversal_of_id = j.id
        ), 0),
        'active',

        j.source_event_id,

        'sc_settlement_item_'
            || v_batch_id::text
            || '_payment_'
            || p.id::text,

        p_actor

    FROM unnest(p_payment_ids) x(payment_id)

    JOIN sport_center.sport_payments p
      ON p.id = x.payment_id

    JOIN sport_center.accounting_journals j
      ON j.payment_id = p.id
     AND j.journal_type =
         'payment_confirmed'
     AND j.is_reversal = false
     AND j.status = 'posted';


    -- ========================================================
    -- FINAL INTERNAL CONSISTENCY CHECK
    -- ========================================================

    IF (
        SELECT COUNT(*)
        FROM sport_center.payment_settlement_items i
        WHERE i.settlement_id = v_batch_id
          AND i.item_status = 'active'
    ) <> v_input_count
    THEN

        RAISE EXCEPTION
            'SETTLEMENT_ITEM_COUNT_MISMATCH';

    END IF;


    IF (
        SELECT ROUND(
            SUM(i.gross_amount)::numeric,
            2
        )
        FROM sport_center.payment_settlement_items i
        WHERE i.settlement_id = v_batch_id
          AND i.item_status = 'active'
    ) <> v_gross
    THEN

        RAISE EXCEPTION
            'SETTLEMENT_ITEM_GROSS_MISMATCH';

    END IF;


    RETURN v_batch_id;

END;
$function$;
COMMIT;
