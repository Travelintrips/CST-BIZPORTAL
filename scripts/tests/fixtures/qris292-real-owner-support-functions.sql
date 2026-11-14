-- Unmodified CST-DEV owner-function SQL captured READ-ONLY 2026-11-14.
-- Install after the synthetic writer tests, in disposable PostgreSQL ONLY.
-- NOT a migration. NEVER run against an active DEV or PROD database.
-- MD5 function sources:
-- calculate_settlement_mdr: 323fd180e30ed75276c5a288541047e6
-- create_payment_settlement_batch_legacy: a5266921d02243db2712c031c7e9540c
-- create_settlement_journal_draft: 4d7994115d187c7a5fa4ecce6411d937
-- finalize_payment_settlement: d6b6ebe66133f967a25d612994503187
-- finalize_payment_settlement_legacy: d26259bc2272e1e7870f5a463cb2c9c4
-- mark_settlement_payments_settled: ee27745f7dacaca6989f61f5b1acbd3a
-- resolve_payment_settlement_config: 7a76acd36d739adb9e14c46a8e843504
-- validate_accounting_journal: ba371e10692db99c0a1f693a6caf541c

CREATE OR REPLACE FUNCTION sport_center.calculate_settlement_mdr(p_gross_amount numeric, p_mdr_rate numeric, p_fixed_provider_fee numeric DEFAULT 0, p_fee_tax_rate numeric DEFAULT 0, p_fee_tax_inclusive boolean DEFAULT false, p_rounding_scale integer DEFAULT 2, p_rounding_method text DEFAULT 'round_half_up'::text)
 RETURNS TABLE(gross_amount numeric, base_mdr_amount numeric, provider_fee_amount numeric, fee_tax_amount numeric, total_deduction numeric, net_amount numeric)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE

    v_base_mdr numeric;
    v_fee numeric;
    v_fee_tax numeric;
    v_total numeric;
    v_net numeric;

BEGIN

    IF p_gross_amount IS NULL
       OR p_gross_amount <= 0 THEN

        RAISE EXCEPTION
            'INVALID_GROSS_AMOUNT';

    END IF;


    IF p_mdr_rate IS NULL
       OR p_mdr_rate < 0
       OR p_mdr_rate > 1 THEN

        RAISE EXCEPTION
            'INVALID_MDR_RATE';

    END IF;


    IF p_fixed_provider_fee < 0 THEN

        RAISE EXCEPTION
            'INVALID_PROVIDER_FEE';

    END IF;


    IF p_fee_tax_rate < 0
       OR p_fee_tax_rate > 1 THEN

        RAISE EXCEPTION
            'INVALID_FEE_TAX_RATE';

    END IF;


    -- ------------------------------------------
    -- Base MDR
    -- ------------------------------------------

    v_base_mdr :=
        p_gross_amount * p_mdr_rate;


    -- ------------------------------------------
    -- Fixed provider fee
    -- ------------------------------------------

    v_fee :=
        COALESCE(
            p_fixed_provider_fee,
            0
        );


    -- ------------------------------------------
    -- Tax on provider fee/MDR
    --
    -- This field exists for provider contract
    -- support only.
    --
    -- DO NOT confuse it with customer PPN.
    -- Customer PPN is already accounted for in
    -- payment revenue journal.
    -- ------------------------------------------

    IF COALESCE(p_fee_tax_rate, 0) > 0 THEN

        IF p_fee_tax_inclusive THEN

            v_fee_tax :=
                (v_base_mdr + v_fee)
                -
                (
                    (v_base_mdr + v_fee)
                    /
                    (1 + p_fee_tax_rate)
                );

        ELSE

            v_fee_tax :=
                (v_base_mdr + v_fee)
                * p_fee_tax_rate;

        END IF;

    ELSE

        v_fee_tax := 0;

    END IF;


    -- ------------------------------------------
    -- Rounding
    -- ------------------------------------------

    IF p_rounding_method = 'floor' THEN

        v_base_mdr :=
            trunc(v_base_mdr, p_rounding_scale);

        v_fee_tax :=
            trunc(v_fee_tax, p_rounding_scale);

    ELSIF p_rounding_method = 'ceil' THEN

        -- PostgreSQL CEIL does not accept scale.
        -- Scale manually.

        v_base_mdr :=
            ceil(
                v_base_mdr
                * power(10, p_rounding_scale)
            )
            /
            power(10, p_rounding_scale);

        v_fee_tax :=
            ceil(
                v_fee_tax
                * power(10, p_rounding_scale)
            )
            /
            power(10, p_rounding_scale);

    ELSE

        v_base_mdr :=
            round(
                v_base_mdr,
                p_rounding_scale
            );

        v_fee_tax :=
            round(
                v_fee_tax,
                p_rounding_scale
            );

    END IF;


    v_total :=
        v_base_mdr
        + v_fee
        + v_fee_tax;


    v_net :=
        p_gross_amount
        - v_total;


    IF v_net < 0 THEN

        RAISE EXCEPTION
            'SETTLEMENT_NET_AMOUNT_NEGATIVE';

    END IF;


    RETURN QUERY
    SELECT

        p_gross_amount,

        v_base_mdr,

        v_fee,

        v_fee_tax,

        v_total,

        v_net;

END;
$function$;

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
    -- ========================================================

    SELECT
        c.base_mdr_amount,
        c.provider_fee_amount,
        c.fee_tax_amount,
        c.total_deduction,
        c.net_amount

      INTO
        v_mdr,
        v_provider_fee,
        v_fee_tax,
        v_total_deduction,
        v_net

      FROM sport_center.calculate_settlement_mdr(
            v_gross,
            v_effective_mdr_rate,
            v_effective_fixed_fee,
            v_config.fee_tax_rate,
            v_config.fee_tax_inclusive,
            v_config.rounding_scale,
            v_config.rounding_method
      ) c;


    -- ========================================================
    
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

CREATE OR REPLACE FUNCTION sport_center.create_settlement_journal_draft(p_settlement_id bigint, p_bank_coa_code text, p_actor text DEFAULT 'manual-supabase'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
DECLARE

    v_settlement
        sport_center.payment_settlement_batches%ROWTYPE;

    v_existing_journal_id integer;

    v_journal_id integer;

    v_bank_account_name text;
    v_clearing_account_code text;
    v_clearing_account_name text;
    v_mdr_account_code text;
    v_mdr_account_name text;

    v_total_debit numeric(18,2);
    v_total_credit numeric(18,2);

    v_item_gross numeric(18,2);

BEGIN

    -- ========================================================
    -- INPUT
    -- ========================================================

    IF p_bank_coa_code IS NULL
       OR btrim(p_bank_coa_code) = '' THEN

        RAISE EXCEPTION
            'BANK_COA_CODE_REQUIRED';

    END IF;


    -- ========================================================
    -- SERIALIZE
    -- ========================================================

    PERFORM pg_advisory_xact_lock(
        873311,
        (p_settlement_id % 2147483647)::integer
    );


    -- ========================================================
    -- LOAD BATCH
    -- ========================================================

    SELECT *
      INTO v_settlement

      FROM sport_center.payment_settlement_batches

     WHERE id = p_settlement_id

     FOR UPDATE;


    IF NOT FOUND THEN

        RAISE EXCEPTION
            'SETTLEMENT_NOT_FOUND: %',
            p_settlement_id;

    END IF;


    -- ========================================================
    -- ONLY CALCULATED SETTLEMENT
    -- ========================================================

    IF v_settlement.status <> 'calculated' THEN

        RAISE EXCEPTION
            'SETTLEMENT_NOT_CALCULATED: settlement=% status=%',
            p_settlement_id,
            v_settlement.status;

    END IF;


    -- ========================================================
    -- IDEMPOTENCY
    -- ========================================================

    SELECT id
      INTO v_existing_journal_id

      FROM sport_center.accounting_journals

     WHERE settlement_batch_id = p_settlement_id
       AND journal_type = 'settlement'
       AND is_reversal = false

     LIMIT 1;


    IF v_existing_journal_id IS NOT NULL THEN

        RETURN v_existing_journal_id;

    END IF;


    -- ========================================================
    -- BANK COA VALIDATION
    -- ========================================================

    SELECT name
      INTO v_bank_account_name

      FROM sport_center.coa_accounts

     WHERE code = p_bank_coa_code
       AND account_type::text = 'asset'
       AND is_active = true

     LIMIT 1;


    IF v_bank_account_name IS NULL THEN

        RAISE EXCEPTION
            'BANK_COA_NOT_FOUND_OR_NOT_ACTIVE_ASSET: %',
            p_bank_coa_code;

    END IF;


    -- ========================================================
    -- CANONICAL PAYMENT CLEARING COA
    -- Resolve by company from the shared public COA master.
    SELECT coa.code, coa.name
      INTO v_clearing_account_code, v_clearing_account_name
      FROM public.chart_of_accounts coa
     WHERE coa.company_id = v_settlement.company_id
       AND coa.code LIKE '1-1024-%'
       AND coa.name ILIKE 'Payment Clearing Sport Center / QRIS%'
       AND coa.account_category = 'ASSET'
       AND coa.is_active = true
       AND coalesce(coa.is_header, false) = false
       AND coalesce(coa.is_postable, true) = true
     ORDER BY coa.id
     LIMIT 1;

    IF v_clearing_account_code IS NULL OR v_clearing_account_name IS NULL THEN
        RAISE EXCEPTION
            'PAYMENT_CLEARING_COA_NOT_FOUND_FOR_COMPANY: %',
            v_settlement.company_id;
    END IF;

    -- CONDITIONAL COA VALIDATION
    -- ========================================================

    IF v_settlement.mdr_amount > 0 THEN
        SELECT coa.code, coa.name
          INTO v_mdr_account_code, v_mdr_account_name
          FROM public.chart_of_accounts coa
         WHERE coa.company_id = v_settlement.company_id
           AND coa.code = '5-3050-CST'
           AND coa.account_category = 'EXPENSE'
           AND coa.is_active = true
           AND coalesce(coa.is_header, false) = false
           AND coalesce(coa.is_postable, true) = true
         LIMIT 1;

        IF v_mdr_account_code IS NULL OR v_mdr_account_name IS NULL THEN
            RAISE EXCEPTION 'MDR_EXPENSE_COA_NOT_FOUND_FOR_COMPANY: %', v_settlement.company_id;
        END IF;
    END IF;


    IF v_settlement.provider_fee_amount > 0
       AND NOT EXISTS (
            SELECT 1
            FROM sport_center.coa_accounts
            WHERE code = '61.17'
              AND account_type::text = 'expense'
              AND is_active = true
       ) THEN

        RAISE EXCEPTION
            'PROVIDER_FEE_COA_NOT_FOUND: 61.17';

    END IF;


    IF v_settlement.fee_tax_amount > 0
       AND NOT EXISTS (
            SELECT 1
            FROM sport_center.coa_accounts
            WHERE code = '61.18'
              AND account_type::text = 'expense'
              AND is_active = true
       ) THEN

        RAISE EXCEPTION
            'PROVIDER_FEE_TAX_COA_NOT_FOUND: 61.18';

    END IF;


    IF v_settlement.adjustment_amount <> 0
       AND NOT EXISTS (
            SELECT 1
            FROM sport_center.coa_accounts
            WHERE code = '61.19'
              AND is_active = true
       ) THEN

        RAISE EXCEPTION
            'SETTLEMENT_ADJUSTMENT_COA_NOT_FOUND: 61.19';

    END IF;


    IF v_settlement.tax_withheld_amount > 0
       AND NOT EXISTS (
            SELECT 1
            FROM sport_center.coa_accounts
            WHERE code = '1198'
              AND account_type::text = 'asset'
              AND is_active = true
       ) THEN

        RAISE EXCEPTION
            'TAX_WITHHELD_COA_NOT_FOUND: 1198';

    END IF;


    -- ========================================================
    -- ACTIVE ITEMS REQUIRED
    -- ========================================================

    SELECT ROUND(
        COALESCE(
            SUM(i.gross_amount),
            0
        )::numeric,
        2
    )
      INTO v_item_gross

      FROM sport_center.payment_settlement_items i

     WHERE i.settlement_id =
           p_settlement_id

       AND i.item_status =
           'active';


    IF v_item_gross <= 0 THEN

        RAISE EXCEPTION
            'SETTLEMENT_HAS_NO_ACTIVE_ITEMS: %',
            p_settlement_id;

    END IF;


    -- ========================================================
    -- ITEM -> HEADER GROSS CONSISTENCY
    -- ========================================================

    IF v_item_gross <>
       v_settlement.gross_amount THEN

        RAISE EXCEPTION
            'SETTLEMENT_GROSS_DOES_NOT_MATCH_ITEMS: settlement=% header=% items=%',
            p_settlement_id,
            v_settlement.gross_amount,
            v_item_gross;

    END IF;


    -- ========================================================
    -- EVERY ITEM MUST COME FROM POSTED PAYMENT JOURNAL
    -- ========================================================

    IF EXISTS (

        SELECT 1

        FROM sport_center.payment_settlement_items i

        LEFT JOIN sport_center.accounting_journals j
          ON j.id = i.payment_journal_id

        WHERE i.settlement_id =
              p_settlement_id

          AND i.item_status =
              'active'

          AND (
               j.id IS NULL
               OR j.status <> 'posted'
               OR j.journal_type <> 'payment_confirmed'
               OR j.is_reversal = true
          )

    ) THEN

        RAISE EXCEPTION
            'SETTLEMENT_CONTAINS_NON_POSTED_PAYMENT_JOURNAL: %',
            p_settlement_id;

    END IF;


    -- ========================================================
    -- CREATE HEADER
    --
    -- Existing header structure is still revenue-oriented.
    --
    -- For settlement journal:
    --
    -- debit_amount          = gross total debit
    -- credit_revenue_amount = Payment Clearing gross
    -- credit_ppn_amount     = 0
    --
    -- journal_type = settlement differentiates semantics.
    -- ========================================================

    INSERT INTO
    sport_center.accounting_journals
    (
        booking_id,
        payment_id,

        settlement_batch_id,

        company_id,

        order_number,

        journal_type,
        status,

        debit_account,
        debit_amount,

        credit_revenue_account,
        credit_revenue_amount,

        credit_ppn_account,
        credit_ppn_amount,

        journal_date,

        gross_amount,
        dpp_amount,
        tax_amount,

        source_schema,
        source_table,
        source_id,
        correlation_id,

        is_reversal,

        notes,

        created_by
    )

    VALUES
    (
        NULL,
        NULL,

        p_settlement_id,

        v_settlement.company_id,

        v_settlement.settlement_reference,

        'settlement',
        'draft',

        v_bank_account_name,
        v_settlement.gross_amount,

        v_clearing_account_name,
        v_settlement.gross_amount,

        'PPN Keluaran',
        0,

        v_settlement.settlement_date::text,

        v_settlement.gross_amount,

        -- Existing generic validation requires:
        -- gross = dpp + tax.
        --
        -- Settlement has no revenue DPP semantics.
        -- We use gross as neutral header amount.
        v_settlement.gross_amount,

        0,

        'sport_center',
        'payment_settlement_batches',
        p_settlement_id::text,

        'sc_settlement_'
            || p_settlement_id::text,

        false,

        'Settlement journal draft: '
            || v_settlement.settlement_reference,

        p_actor
    )

    RETURNING id
      INTO v_journal_id;

    UPDATE sport_center.accounting_journals
       SET settlement_reference = v_settlement.settlement_reference,
           settlement_date = v_settlement.settlement_date,
           bank_account_id = v_settlement.bank_account_id,
           provider_name = v_settlement.provider_name,
           settlement_status = v_settlement.status::text,
           mdr_amount = v_settlement.mdr_amount,
           updated_at = now()
     WHERE id = v_journal_id;


    -- ========================================================
    -- JOURNAL LINES
    -- ========================================================


    -- --------------------------------------------------------
    -- DR BANK — NET
    -- --------------------------------------------------------

    INSERT INTO
    sport_center.accounting_journal_lines
    (
        journal_id,
        line_type,
        account_code,
        account_name,
        amount,
        description
    )

    VALUES
    (
        v_journal_id,

        'debit',

        p_bank_coa_code,
        v_bank_account_name,

        v_settlement.net_amount,

        'Net settlement '
            || v_settlement.settlement_reference
    );


    -- --------------------------------------------------------
    -- DR MDR
    -- --------------------------------------------------------

    IF v_settlement.mdr_amount > 0 THEN

        INSERT INTO
        sport_center.accounting_journal_lines
        (
            journal_id,
            line_type,
            account_code,
            account_name,
            amount,
            description
        )

        VALUES
        (
            v_journal_id,

            'debit',

            v_mdr_account_code,
            v_mdr_account_name,

            v_settlement.mdr_amount,

            'MDR '
                || v_settlement.settlement_reference
        );

    END IF;


    -- --------------------------------------------------------
    -- DR PROVIDER FEE
    -- --------------------------------------------------------

    IF v_settlement.provider_fee_amount > 0 THEN

        INSERT INTO
        sport_center.accounting_journal_lines
        (
            journal_id,
            line_type,
            account_code,
            account_name,
            amount,
            description
        )

        VALUES
        (
            v_journal_id,

            'debit',

            '61.17',
            'Biaya Provider Payment',

            v_settlement.provider_fee_amount,

            'Provider fee '
                || v_settlement.settlement_reference
        );

    END IF;


    -- --------------------------------------------------------
    -- DR PROVIDER FEE TAX
    -- --------------------------------------------------------

    IF v_settlement.fee_tax_amount > 0 THEN

        INSERT INTO
        sport_center.accounting_journal_lines
        (
            journal_id,
            line_type,
            account_code,
            account_name,
            amount,
            description
        )

        VALUES
        (
            v_journal_id,

            'debit',

            '61.18',
            'Pajak Biaya Provider',

            v_settlement.fee_tax_amount,

            'Provider fee tax '
                || v_settlement.settlement_reference
        );

    END IF;


    -- --------------------------------------------------------
    -- DR TAX WITHHELD RECEIVABLE
    -- --------------------------------------------------------

    IF v_settlement.tax_withheld_amount > 0 THEN

        INSERT INTO
        sport_center.accounting_journal_lines
        (
            journal_id,
            line_type,
            account_code,
            account_name,
            amount,
            description
        )

        VALUES
        (
            v_journal_id,

            'debit',

            '1198',
            'Pajak Dipotong Dimuka Settlement',

            v_settlement.tax_withheld_amount,

            'Tax withheld '
                || v_settlement.settlement_reference
        );

    END IF;


    -- ========================================================
    -- ADJUSTMENT — CORRECT ACCOUNTING DIRECTION
    --
    -- net =
    -- gross
    -- - deductions
    -- + adjustment
    --
    -- Positive adjustment raises net.
    -- Therefore CREDIT adjustment is needed to balance.
    --
    -- Negative adjustment lowers net.
    -- Therefore DEBIT adjustment is needed to balance.
    -- ========================================================

    IF v_settlement.adjustment_amount > 0 THEN

        INSERT INTO
        sport_center.accounting_journal_lines
        (
            journal_id,
            line_type,
            account_code,
            account_name,
            amount,
            description
        )

        VALUES
        (
            v_journal_id,

            'credit',

            '61.19',
            'Penyesuaian Settlement',

            v_settlement.adjustment_amount,

            'Positive settlement adjustment '
                || v_settlement.settlement_reference
        );


    ELSIF v_settlement.adjustment_amount < 0 THEN

        INSERT INTO
        sport_center.accounting_journal_lines
        (
            journal_id,
            line_type,
            account_code,
            account_name,
            amount,
            description
        )

        VALUES
        (
            v_journal_id,

            'debit',

            '61.19',
            'Penyesuaian Settlement',

            abs(
                v_settlement.adjustment_amount
            ),

            'Negative settlement adjustment '
                || v_settlement.settlement_reference
        );

    END IF;


    -- --------------------------------------------------------
    -- CR PAYMENT CLEARING — GROSS
    -- --------------------------------------------------------

    INSERT INTO
    sport_center.accounting_journal_lines
    (
        journal_id,
        line_type,
        account_code,
        account_name,
        amount,
        description
    )

    VALUES
    (
        v_journal_id,

        'credit',

        v_clearing_account_code,
        v_clearing_account_name,

        v_settlement.gross_amount,

        'Clear Payment Clearing '
            || v_settlement.settlement_reference
    );


    -- ========================================================
    -- BALANCE
    -- ========================================================

    SELECT
        COALESCE(
            SUM(amount)
            FILTER (
                WHERE line_type = 'debit'
            ),
            0
        ),

        COALESCE(
            SUM(amount)
            FILTER (
                WHERE line_type = 'credit'
            ),
            0
        )

      INTO
        v_total_debit,
        v_total_credit

      FROM
        sport_center.accounting_journal_lines

     WHERE journal_id =
           v_journal_id;


    IF ROUND(v_total_debit, 2)
       <> ROUND(v_total_credit, 2) THEN

        RAISE EXCEPTION
            'SETTLEMENT_JOURNAL_UNBALANCED: journal=% debit=% credit=%',
            v_journal_id,
            v_total_debit,
            v_total_credit;

    END IF;


    -- ========================================================
    -- GENERAL VALIDATION
    -- ========================================================

    PERFORM
        sport_center.validate_accounting_journal(
            v_journal_id
        );


    -- ========================================================
    -- LINK BATCH -> JOURNAL
    -- ========================================================

    UPDATE
        sport_center.payment_settlement_batches

       SET settlement_journal_id =
               v_journal_id,

           updated_at =
               now()

     WHERE id =
           p_settlement_id;


    RETURN v_journal_id;

END;
$function$;

CREATE OR REPLACE FUNCTION sport_center.finalize_payment_settlement(p_settlement_id bigint, p_actor text DEFAULT 'manual-supabase'::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
    DECLARE
      v_result bigint;
    BEGIN
      v_result := sport_center.finalize_payment_settlement_legacy(
        p_settlement_id,
        p_actor
      );
      PERFORM sport_center.mark_settlement_payments_settled(
        p_settlement_id,
        p_actor
      );
      RETURN v_result;
    END;
    $function$;

CREATE OR REPLACE FUNCTION sport_center.finalize_payment_settlement_legacy(p_settlement_id bigint, p_actor text DEFAULT 'manual-supabase'::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
DECLARE

    v_settlement
        sport_center.payment_settlement_batches%ROWTYPE;

    v_journal
        sport_center.accounting_journals%ROWTYPE;

    v_item_gross numeric(18,2);

BEGIN

    -- --------------------------------------------------------
    -- Serialize settlement finalization
    -- --------------------------------------------------------

    PERFORM pg_advisory_xact_lock(
        992341,
        (p_settlement_id % 2147483647)::integer
    );


    -- --------------------------------------------------------
    -- Load settlement
    -- --------------------------------------------------------

    SELECT *
      INTO v_settlement

      FROM sport_center.payment_settlement_batches

     WHERE id = p_settlement_id

     FOR UPDATE;


    IF NOT FOUND THEN

        RAISE EXCEPTION
            'SETTLEMENT_NOT_FOUND: %',
            p_settlement_id;

    END IF;


    -- --------------------------------------------------------
    -- Idempotent retry:
    --
    -- already posted/reconciled = return existing ID
    -- --------------------------------------------------------

    IF v_settlement.status IN (
        'posted',
        'reconciled'
    ) THEN

        IF v_settlement.settlement_journal_id IS NULL THEN

            RAISE EXCEPTION
                'FINALIZED_SETTLEMENT_MISSING_JOURNAL: %',
                p_settlement_id;

        END IF;


        SELECT *
          INTO v_journal

          FROM sport_center.accounting_journals

         WHERE id =
               v_settlement.settlement_journal_id;


        IF NOT FOUND
           OR v_journal.status <> 'posted' THEN

            RAISE EXCEPTION
                'FINALIZED_SETTLEMENT_JOURNAL_NOT_POSTED: %',
                p_settlement_id;

        END IF;


        RETURN p_settlement_id;

    END IF;


    -- --------------------------------------------------------
    -- Only CALCULATED may finalize
    -- --------------------------------------------------------

    IF v_settlement.status <> 'calculated' THEN

        RAISE EXCEPTION
            'SETTLEMENT_NOT_READY_TO_FINALIZE: settlement=% status=%',
            p_settlement_id,
            v_settlement.status;

    END IF;


    -- --------------------------------------------------------
    -- Must already have settlement journal
    -- --------------------------------------------------------

    IF v_settlement.settlement_journal_id IS NULL THEN

        RAISE EXCEPTION
            'SETTLEMENT_JOURNAL_REQUIRED: %',
            p_settlement_id;

    END IF;


    -- --------------------------------------------------------
    -- Journal linkage validation
    -- --------------------------------------------------------

    SELECT *
      INTO v_journal

      FROM sport_center.accounting_journals

     WHERE id =
           v_settlement.settlement_journal_id

     FOR UPDATE;


    IF NOT FOUND THEN

        RAISE EXCEPTION
            'SETTLEMENT_JOURNAL_NOT_FOUND: %',
            v_settlement.settlement_journal_id;

    END IF;


    IF v_journal.settlement_batch_id
       IS DISTINCT FROM p_settlement_id THEN

        RAISE EXCEPTION
            'SETTLEMENT_JOURNAL_LINK_MISMATCH: settlement=% journal=%',
            p_settlement_id,
            v_journal.id;

    END IF;


    IF v_journal.journal_type <> 'settlement' THEN

        RAISE EXCEPTION
            'INVALID_SETTLEMENT_JOURNAL_TYPE: journal=% type=%',
            v_journal.id,
            v_journal.journal_type;

    END IF;


    IF v_journal.is_reversal = true THEN

        RAISE EXCEPTION
            'REVERSAL_JOURNAL_CANNOT_FINALIZE_SETTLEMENT: %',
            v_journal.id;

    END IF;


    IF v_journal.status NOT IN (
        'draft',
        'approved',
        'posted'
    ) THEN

        RAISE EXCEPTION
            'SETTLEMENT_JOURNAL_INVALID_STATUS: journal=% status=%',
            v_journal.id,
            v_journal.status;

    END IF;


    -- --------------------------------------------------------
    -- Verify active items still equal batch gross
    -- --------------------------------------------------------

    SELECT ROUND(
        COALESCE(
            SUM(i.gross_amount),
            0
        )::numeric,
        2
    )

      INTO v_item_gross

      FROM sport_center.payment_settlement_items i

     WHERE i.settlement_id =
           p_settlement_id

       AND i.item_status =
           'active';


    IF v_item_gross
       <> v_settlement.gross_amount THEN

        RAISE EXCEPTION
            'SETTLEMENT_ITEM_GROSS_MISMATCH: settlement=% header=% items=%',
            p_settlement_id,
            v_settlement.gross_amount,
            v_item_gross;

    END IF;


    -- --------------------------------------------------------
    -- Every payment journal must still be POSTED
    -- --------------------------------------------------------

    IF EXISTS (

        SELECT 1

        FROM sport_center.payment_settlement_items i

        LEFT JOIN sport_center.accounting_journals pj
          ON pj.id =
             i.payment_journal_id

        WHERE i.settlement_id =
              p_settlement_id

          AND i.item_status =
              'active'

          AND (
               pj.id IS NULL
               OR pj.status <> 'posted'
               OR pj.journal_type <> 'payment_confirmed'
               OR pj.is_reversal = true
          )

    ) THEN

        RAISE EXCEPTION
            'SETTLEMENT_HAS_INVALID_PAYMENT_JOURNAL: %',
            p_settlement_id;

    END IF;


    -- --------------------------------------------------------
    -- Revalidate settlement journal balance
    -- --------------------------------------------------------

    PERFORM
        sport_center.validate_accounting_journal(
            v_journal.id
        );


    -- ========================================================
    -- APPROVE
    -- ========================================================

    IF v_journal.status = 'draft' THEN

        PERFORM
            sport_center.approve_accounting_journal(
                v_journal.id,
                p_actor
            );

    END IF;


    -- ========================================================
    -- POST
    -- ========================================================

    IF v_journal.status <> 'posted' THEN
    PERFORM
        sport_center.post_accounting_journal(
            v_journal.id,
            p_actor
        );
    END IF;


    -- --------------------------------------------------------
    -- Confirm journal actually posted
    -- --------------------------------------------------------

    SELECT *
      INTO v_journal

      FROM sport_center.accounting_journals

     WHERE id =
           v_settlement.settlement_journal_id;


    IF v_journal.status <> 'posted' THEN

        RAISE EXCEPTION
            'SETTLEMENT_JOURNAL_POST_FAILED: %',
            v_journal.id;

    END IF;


    -- ========================================================
    -- MARK SETTLEMENT POSTED
    --
    -- This happens only after accounting journal posted.
    -- ========================================================

    UPDATE
        sport_center.payment_settlement_batches

       SET status =
               'posted',

           posted_at =
               now(),

           posted_by =
               p_actor,

           updated_at =
               now()

     WHERE id =
           p_settlement_id;


    RETURN p_settlement_id;

END;
$function$;

CREATE OR REPLACE FUNCTION sport_center.mark_settlement_payments_settled(p_settlement_id bigint, p_actor text DEFAULT 'canonical-settlement-owner'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
    DECLARE
      v_batch sport_center.payment_settlement_batches%ROWTYPE;
      v_journal sport_center.accounting_journals%ROWTYPE;
      v_payment record;
      v_item_count integer;
      v_processed integer := 0;
      v_updated integer;
    BEGIN
      SELECT *
        INTO v_batch
        FROM sport_center.payment_settlement_batches
       WHERE id = p_settlement_id
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND: %', p_settlement_id;
      END IF;

      IF v_batch.status NOT IN ('posted', 'reconciled') THEN
        RAISE EXCEPTION
          'SETTLEMENT_NOT_POSTED_FOR_PAYMENT_STATE: settlement=% status=%',
          p_settlement_id,
          v_batch.status;
      END IF;

      IF v_batch.settlement_journal_id IS NULL THEN
        RAISE EXCEPTION 'SETTLEMENT_JOURNAL_REQUIRED: %', p_settlement_id;
      END IF;

      SELECT *
        INTO v_journal
        FROM sport_center.accounting_journals
       WHERE id = v_batch.settlement_journal_id
       FOR UPDATE;

      IF NOT FOUND OR v_journal.status <> 'posted' THEN
        RAISE EXCEPTION
          'SETTLEMENT_JOURNAL_NOT_POSTED: settlement=% journal=%',
          p_settlement_id,
          v_batch.settlement_journal_id;
      END IF;

      SELECT COUNT(*)::int
        INTO v_item_count
        FROM sport_center.payment_settlement_items
       WHERE settlement_id = p_settlement_id
         AND item_status = 'active';

      IF v_item_count = 0 THEN
        RAISE EXCEPTION 'SETTLEMENT_ACTIVE_ITEMS_REQUIRED: %', p_settlement_id;
      END IF;

      /*
       * This ordered FOR UPDATE is the sole canonical payment-state owner.
       * A retry is idempotent only when the payment is already settled through
       * an active item belonging to this same batch.
       */
      FOR v_payment IN
        SELECT
          p.id,
          p.status::text AS payment_status,
          p.settlement_status
        FROM sport_center.payment_settlement_items i
        JOIN sport_center.sport_payments p
          ON p.id = i.payment_id
        WHERE i.settlement_id = p_settlement_id
          AND i.item_status = 'active'
        ORDER BY p.id
        FOR UPDATE OF p
      LOOP
        IF v_payment.payment_status <> 'confirmed' THEN
          RAISE EXCEPTION
            'CANONICAL_PAYMENT_NOT_CONFIRMED: payment=% status=%',
            v_payment.id,
            v_payment.payment_status;
        END IF;

        IF v_payment.settlement_status = 'settled' THEN
          v_processed := v_processed + 1;
          CONTINUE;
        END IF;

        IF v_payment.settlement_status <> 'unsettled' THEN
          RAISE EXCEPTION
            'CANONICAL_PAYMENT_SETTLEMENT_STATE_CONFLICT: payment=% state=%',
            v_payment.id,
            v_payment.settlement_status;
        END IF;

        UPDATE sport_center.sport_payments
           SET settlement_status = 'settled',
               updated_at = now()
         WHERE id = v_payment.id
           AND settlement_status = 'unsettled';

        GET DIAGNOSTICS v_updated = ROW_COUNT;
        IF v_updated <> 1 THEN
          RAISE EXCEPTION
            'CANONICAL_PAYMENT_SETTLEMENT_STATE_RACE: payment=%',
            v_payment.id;
        END IF;

        v_processed := v_processed + 1;
      END LOOP;

      RETURN v_processed;
    END;
    $function$;

CREATE OR REPLACE FUNCTION sport_center.resolve_payment_settlement_config(p_company_id integer, p_provider_code text, p_bank_account_id text, p_effective_date date)
 RETURNS sport_center.payment_settlement_configs
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
DECLARE

    v_config
        sport_center.payment_settlement_configs%ROWTYPE;

    v_count integer;

BEGIN

    SELECT COUNT(*)
      INTO v_count
      FROM sport_center.payment_settlement_configs c
     WHERE c.company_id = p_company_id
       AND lower(c.provider_code)
           = lower(p_provider_code)
       AND c.bank_account_id = p_bank_account_id
       AND c.is_active = true
       AND c.effective_from <= p_effective_date
       AND (
            c.effective_until IS NULL
            OR c.effective_until >= p_effective_date
       );


    IF v_count = 0 THEN

        RAISE EXCEPTION
            'SETTLEMENT_CONFIG_NOT_FOUND: company=% provider=% bank=% date=%',
            p_company_id,
            p_provider_code,
            p_bank_account_id,
            p_effective_date;

    END IF;


    IF v_count > 1 THEN

        RAISE EXCEPTION
            'MULTIPLE_SETTLEMENT_CONFIGS_FOUND: company=% provider=% bank=% date=% count=%',
            p_company_id,
            p_provider_code,
            p_bank_account_id,
            p_effective_date,
            v_count;

    END IF;


    SELECT *
      INTO v_config
      FROM sport_center.payment_settlement_configs c
     WHERE c.company_id = p_company_id
       AND lower(c.provider_code)
           = lower(p_provider_code)
       AND c.bank_account_id = p_bank_account_id
       AND c.is_active = true
       AND c.effective_from <= p_effective_date
       AND (
            c.effective_until IS NULL
            OR c.effective_until >= p_effective_date
       )
     LIMIT 1;


    IF v_config.mdr_rate IS NULL THEN

        RAISE EXCEPTION
            'CANONICAL_MDR_RATE_NOT_CONFIGURED: config_id=%',
            v_config.id;

    END IF;


    RETURN v_config;

END;
$function$;

CREATE OR REPLACE FUNCTION sport_center.validate_accounting_journal(p_journal_id integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
DECLARE
    v_journal sport_center.accounting_journals%ROWTYPE;
    v_total_debit numeric;
    v_total_credit numeric;
    v_line_count integer;
BEGIN
    SELECT *
      INTO v_journal
      FROM sport_center.accounting_journals
     WHERE id = p_journal_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'ACCOUNTING_JOURNAL_NOT_FOUND: %',
            p_journal_id;
    END IF;

    SELECT
        COALESCE(SUM(amount) FILTER (WHERE line_type = 'debit'), 0),
        COALESCE(SUM(amount) FILTER (WHERE line_type = 'credit'), 0),
        COUNT(*)
      INTO v_total_debit, v_total_credit, v_line_count
      FROM sport_center.accounting_journal_lines
     WHERE journal_id = p_journal_id;

    IF v_line_count = 0 THEN
        RAISE EXCEPTION 'ACCOUNTING_JOURNAL_HAS_NO_LINES: %', p_journal_id;
    END IF;

    IF v_total_debit <> v_total_credit THEN
        RAISE EXCEPTION 'ACCOUNTING_JOURNAL_UNBALANCED: journal=% debit=% credit=%',
            p_journal_id, v_total_debit, v_total_credit;
    END IF;

    IF v_journal.debit_amount <> (v_journal.credit_revenue_amount + v_journal.credit_ppn_amount) THEN
        RAISE EXCEPTION 'ACCOUNTING_JOURNAL_HEADER_UNBALANCED: %', p_journal_id;
    END IF;

    IF v_journal.gross_amount IS NOT NULL
       AND v_journal.dpp_amount IS NOT NULL
       AND v_journal.tax_amount IS NOT NULL
       AND v_journal.gross_amount <> (v_journal.dpp_amount + v_journal.tax_amount) THEN
        RAISE EXCEPTION 'ACCOUNTING_JOURNAL_TAX_MISMATCH: %', p_journal_id;
    END IF;

    IF v_journal.journal_type = 'payment_confirmed' THEN

        IF v_journal.payment_id IS NULL THEN
            RAISE EXCEPTION 'PAYMENT_ID_REQUIRED: %', p_journal_id;
        END IF;

        -- company_id is optional: individual (non-company) bookings have no company.
        -- Only validate company_id when it is explicitly set.

        IF v_journal.payment_method IS NULL THEN
            RAISE EXCEPTION 'PAYMENT_METHOD_REQUIRED: %', p_journal_id;
        END IF;

        IF v_journal.payment_type IS NULL THEN
            RAISE EXCEPTION 'PAYMENT_TYPE_REQUIRED: %', p_journal_id;
        END IF;

    END IF;

END;
$function$;
