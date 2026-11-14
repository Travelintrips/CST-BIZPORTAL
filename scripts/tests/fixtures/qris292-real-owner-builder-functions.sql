-- Exact function bodies retrieved read-only from CST-DEV PostgreSQL on 2026-11-14.
-- These are installed ONLY into the disposable PostgreSQL 16 CI database.
-- Do NOT run on shared DEV/PROD or deploy these definitions as migrations.
-- create_payment_settlement_batch: d1221f0de73bb9f144d2ec334fd09a5b
-- create_payment_settlement_supplemental_batch: 98d9b976961567211f95fe4ca97d0dd7

CREATE OR REPLACE FUNCTION sport_center.create_payment_settlement_batch(p_settlement_reference text, p_company_id integer, p_provider_code text, p_bank_account_id text, p_settlement_date date, p_payment_ids integer[], p_actor text DEFAULT 'manual-supabase'::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
    DECLARE
      v_input_count integer;
      v_unique_count integer;
      v_confirmed_count integer;
      v_invalid_date_count integer;
      v_rule_min text;
      v_rule_max text;
      v_existing_batch_id bigint;
      v_reference text;
      v_correlation text;
      v_serialized text;
      v_identity record;
      v_result bigint;
      v_item_count integer;
    BEGIN
      IF p_payment_ids IS NULL OR cardinality(p_payment_ids) = 0 THEN
        RAISE EXCEPTION 'PAYMENT_IDS_REQUIRED';
      END IF;

      v_input_count := cardinality(p_payment_ids);
      SELECT COUNT(DISTINCT x.payment_id)
        INTO v_unique_count
        FROM unnest(p_payment_ids) x(payment_id);
      IF v_input_count <> v_unique_count THEN
        RAISE EXCEPTION 'DUPLICATE_PAYMENT_ID_IN_REQUEST';
      END IF;

      SELECT
        COUNT(*)::int,
        COUNT(*) FILTER (
          WHERE p.expected_settlement_date IS DISTINCT FROM p_settlement_date::text
        )::int,
        MIN(NULLIF(btrim(p.settlement_rule_version), '')),
        MAX(NULLIF(btrim(p.settlement_rule_version), ''))
        INTO
          v_confirmed_count,
          v_invalid_date_count,
          v_rule_min,
          v_rule_max
        FROM unnest(p_payment_ids) x(payment_id)
        JOIN sport_center.sport_payments p
          ON p.id = x.payment_id
       WHERE p.status::text = 'confirmed'
         AND p.company_id = p_company_id
         AND lower(p.payment_provider::text) = lower(btrim(p_provider_code))
         AND p.bank_account_id = btrim(p_bank_account_id);

      IF v_confirmed_count <> v_input_count
         OR v_invalid_date_count <> 0
         OR v_rule_min IS NULL
         OR v_rule_min IS DISTINCT FROM v_rule_max
      THEN
        RAISE EXCEPTION
          'CANONICAL_SETTLEMENT_GROUP_INVALID: expected_date/provider/bank/rule mismatch';
      END IF;

      SELECT settlement_reference, correlation_id
        INTO v_identity
        FROM sport_center.canonical_settlement_group_identity(
          p_company_id,
          p_provider_code,
          p_bank_account_id,
          p_settlement_date,
          v_rule_min
        );
      v_reference := v_identity.settlement_reference;
      v_correlation := v_identity.correlation_id;

      v_serialized :=
          p_company_id::text || '|'
          || lower(btrim(p_provider_code)) || '|'
          || btrim(p_bank_account_id) || '|'
          || p_settlement_date::text || '|'
          || v_rule_min;
      PERFORM pg_advisory_xact_lock(hashtext(v_serialized));

      SELECT id
        INTO v_existing_batch_id
        FROM sport_center.payment_settlement_batches
       WHERE company_id = p_company_id
         AND lower(provider_code) = lower(btrim(p_provider_code))
         AND bank_account_id = btrim(p_bank_account_id)
         AND settlement_date = p_settlement_date
         AND settlement_rule_version = v_rule_min
         AND status IN ('draft', 'calculated', 'posted', 'reconciled')
       FOR UPDATE;

      IF v_existing_batch_id IS NOT NULL THEN
        SELECT COUNT(*)::int
          INTO v_item_count
          FROM sport_center.payment_settlement_items
         WHERE settlement_id = v_existing_batch_id
           AND item_status = 'active';

        IF v_item_count <> v_input_count
           OR EXISTS (
             SELECT 1
             FROM unnest(p_payment_ids) x(payment_id)
             WHERE NOT EXISTS (
               SELECT 1
               FROM sport_center.payment_settlement_items i
               WHERE i.settlement_id = v_existing_batch_id
                 AND i.payment_id = x.payment_id
                 AND i.item_status = 'active'
             )
           )
        THEN
          RAISE EXCEPTION
            'CANONICAL_SETTLEMENT_IDEMPOTENCY_CONFLICT: batch=%',
            v_existing_batch_id;
        END IF;

        RETURN v_existing_batch_id;
      END IF;

      SELECT sport_center.create_payment_settlement_batch_legacy(
        v_reference,
        p_company_id,
        lower(btrim(p_provider_code)),
        btrim(p_bank_account_id),
        p_settlement_date,
        p_payment_ids,
        p_actor
      )
        INTO v_result;

      UPDATE sport_center.payment_settlement_batches
         SET settlement_reference = v_reference,
             correlation_id = v_correlation,
             settlement_rule_version = v_rule_min,
             updated_at = now()
       WHERE id = v_result
         AND status = 'calculated';

      RETURN v_result;
    END;
    $function$;

CREATE OR REPLACE FUNCTION sport_center.create_payment_settlement_supplemental_batch(p_company_id integer, p_provider_code text, p_bank_account_id text, p_settlement_date date, p_base_rule_version text, p_payment_ids integer[], p_actor text DEFAULT 'manual-supabase'::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
    DECLARE
      v_input_count integer;
      v_unique_count integer;
      v_confirmed_count integer;
      v_invalid_date_count integer;
      v_valid_count integer;
      v_rule_min text;
      v_config sport_center.payment_settlement_configs%ROWTYPE;
      v_gross numeric(18,2);
      v_effective_mdr_rate numeric;
      v_effective_fixed_fee numeric;
      v_mdr numeric(18,2);
      v_provider_fee numeric(18,2);
      v_fee_tax numeric(18,2);
      v_total_deduction numeric(18,2);
      v_net numeric(18,2);
      v_identity record;
      v_existing_batch_id bigint;
      v_sequence integer;
      v_reference text;
      v_correlation text;
      v_supplemental_rule text;
      v_result bigint;
    BEGIN
      IF p_payment_ids IS NULL OR cardinality(p_payment_ids) = 0 THEN
        RAISE EXCEPTION 'PAYMENT_IDS_REQUIRED';
      END IF;

      v_input_count := cardinality(p_payment_ids);
      SELECT COUNT(DISTINCT x.payment_id)
        INTO v_unique_count
        FROM unnest(p_payment_ids) x(payment_id);
      IF v_input_count <> v_unique_count THEN
        RAISE EXCEPTION 'DUPLICATE_PAYMENT_ID_IN_REQUEST';
      END IF;

      SELECT
        COUNT(*)::int,
        COUNT(*) FILTER (
          WHERE p.expected_settlement_date IS DISTINCT FROM p_settlement_date::text
        )::int,
        MIN(NULLIF(btrim(p.settlement_rule_version), ''))
        INTO v_confirmed_count, v_invalid_date_count, v_rule_min
        FROM unnest(p_payment_ids) x(payment_id)
        JOIN sport_center.sport_payments p
          ON p.id = x.payment_id
       WHERE p.status::text = 'confirmed'
         AND p.company_id = p_company_id
         AND lower(p.payment_provider::text) = lower(btrim(p_provider_code))
         AND p.bank_account_id = btrim(p_bank_account_id)
         AND p.settlement_rule_version = p_base_rule_version;

      IF v_confirmed_count <> v_input_count
         OR v_invalid_date_count <> 0
         OR v_rule_min IS DISTINCT FROM btrim(p_base_rule_version)
      THEN
        RAISE EXCEPTION
          'CANONICAL_SETTLEMENT_GROUP_INVALID: supplemental payment group mismatch';
      END IF;

      SELECT settlement_reference, correlation_id
        INTO v_identity
        FROM sport_center.canonical_settlement_group_identity(
          p_company_id,
          p_provider_code,
          p_bank_account_id,
          p_settlement_date,
          p_base_rule_version
        );

      PERFORM pg_advisory_xact_lock(hashtext(
        p_company_id::text || '|'
        || lower(btrim(p_provider_code)) || '|'
        || btrim(p_bank_account_id) || '|'
        || p_settlement_date::text || '|'
        || btrim(p_base_rule_version)
      ));

      /*
       * Exact active-item-set lookup is the idempotency boundary.  It runs
       * before sequence allocation so a retry never consumes a new sequence.
       */
      SELECT b.id
        INTO v_existing_batch_id
        FROM sport_center.payment_settlement_batches b
       WHERE b.company_id = p_company_id
         AND lower(b.provider_code) = lower(btrim(p_provider_code))
         AND b.bank_account_id = btrim(p_bank_account_id)
         AND b.settlement_date = p_settlement_date
         AND b.status IN ('draft', 'calculated', 'posted', 'reconciled')
         AND b.correlation_id LIKE v_identity.correlation_id || ':supp:%'
         AND (
           SELECT COUNT(*)::int
             FROM sport_center.payment_settlement_items i
            WHERE i.settlement_id = b.id
              AND i.item_status = 'active'
         ) = v_input_count
         AND NOT EXISTS (
           SELECT 1
             FROM sport_center.payment_settlement_items i
            WHERE i.settlement_id = b.id
              AND i.item_status = 'active'
              AND NOT (i.payment_id = ANY(p_payment_ids))
         )
         AND NOT EXISTS (
           SELECT 1
             FROM unnest(p_payment_ids) x(payment_id)
            WHERE NOT EXISTS (
              SELECT 1
                FROM sport_center.payment_settlement_items i
               WHERE i.settlement_id = b.id
                 AND i.payment_id = x.payment_id
                 AND i.item_status = 'active'
            )
         )
       ORDER BY b.id
       LIMIT 1
       FOR UPDATE;

      IF v_existing_batch_id IS NOT NULL THEN
        RETURN v_existing_batch_id;
      END IF;

      IF EXISTS (
        SELECT 1
          FROM sport_center.payment_settlement_items i
          JOIN sport_center.payment_settlement_batches b
            ON b.id = i.settlement_id
         WHERE i.payment_id = ANY(p_payment_ids)
           AND i.item_status = 'active'
      ) THEN
        RAISE EXCEPTION
          'CANONICAL_SETTLEMENT_ITEM_ALREADY_ACTIVE: supplemental payment is already active';
      END IF;

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
         AND lower(COALESCE(p.payment_provider::text, '')) =
             lower(p_provider_code)
         AND p.bank_account_id = p_bank_account_id
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

      SELECT ROUND(SUM(j.gross_amount)::numeric, 2)
        INTO v_gross
        FROM unnest(p_payment_ids) x(payment_id)
        JOIN sport_center.accounting_journals j
          ON j.payment_id = x.payment_id
         AND j.journal_type = 'payment_confirmed'
         AND j.is_reversal = false
         AND j.status = 'posted';

      IF v_gross IS NULL OR v_gross <= 0 THEN
        RAISE EXCEPTION 'INVALID_SETTLEMENT_GROSS';
      END IF;

      SELECT *
        INTO v_config
        FROM sport_center.resolve_payment_settlement_config(
          p_company_id,
          p_provider_code,
          p_bank_account_id,
          p_settlement_date
        );

      CASE v_config.calculation_method
        WHEN 'percentage_of_gross' THEN
          v_effective_mdr_rate := v_config.mdr_rate;
          v_effective_fixed_fee := 0;
        WHEN 'fixed_fee' THEN
          v_effective_mdr_rate := 0;
          v_effective_fixed_fee := v_config.fixed_provider_fee;
        WHEN 'percentage_plus_fixed' THEN
          v_effective_mdr_rate := v_config.mdr_rate;
          v_effective_fixed_fee := v_config.fixed_provider_fee;
        ELSE
          RAISE EXCEPTION
            'UNSUPPORTED_SETTLEMENT_CALCULATION_METHOD: %',
            v_config.calculation_method;
      END CASE;

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

SELECT COALESCE(MAX(
        CASE
          WHEN (regexp_match(
            b.correlation_id,
            v_identity.correlation_id || ':supp:([0-9]+)$'
          ))[1] IS NULL THEN 0
          ELSE ((regexp_match(
            b.correlation_id,
            v_identity.correlation_id || ':supp:([0-9]+)$'
          ))[1])::integer
        END
      ), 0) + 1
        INTO v_sequence
        FROM sport_center.payment_settlement_batches b
       WHERE b.company_id = p_company_id
         AND lower(b.provider_code) = lower(btrim(p_provider_code))
         AND b.bank_account_id = btrim(p_bank_account_id)
         AND b.settlement_date = p_settlement_date
         AND b.status IN ('draft', 'calculated', 'posted', 'reconciled')
         AND b.correlation_id LIKE v_identity.correlation_id || ':supp:%';

      v_reference := v_identity.settlement_reference
        || ':SUPPLEMENTAL-' || lpad(v_sequence::text, 2, '0');
      v_correlation := v_identity.correlation_id
        || ':supp:' || lpad(v_sequence::text, 2, '0');
      v_supplemental_rule := btrim(p_base_rule_version)
        || ':SUPPLEMENTAL-' || lpad(v_sequence::text, 2, '0');

      INSERT INTO sport_center.payment_settlement_batches
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
        created_by,
        notes
      )
      VALUES
      (
        v_reference,
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
        v_supplemental_rule,
        'SPORT_CENTER',
        v_correlation,
        p_actor,
        'LATE_ARRIVAL_SUPPLEMENTAL base=' || v_identity.correlation_id
          || ' sequence=' || lpad(v_sequence::text, 2, '0')
      )
      RETURNING id INTO v_result;

      INSERT INTO sport_center.payment_settlement_items
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
        v_result,
        p.id,
        j.id,
        j.gross_amount,
        'active',
        j.source_event_id,
        'sc_settlement_item_' || v_result::text || '_payment_' || p.id::text,
        p_actor
      FROM unnest(p_payment_ids) x(payment_id)
      JOIN sport_center.sport_payments p
        ON p.id = x.payment_id
      JOIN sport_center.accounting_journals j
        ON j.payment_id = p.id
       AND j.journal_type = 'payment_confirmed'
       AND j.is_reversal = false
       AND j.status = 'posted';

      IF (
        SELECT COUNT(*)
          FROM sport_center.payment_settlement_items i
         WHERE i.settlement_id = v_result
           AND i.item_status = 'active'
      ) <> v_input_count
      THEN
        RAISE EXCEPTION 'SETTLEMENT_ITEM_COUNT_MISMATCH';
      END IF;

      IF (
        SELECT ROUND(SUM(i.gross_amount)::numeric, 2)
          FROM sport_center.payment_settlement_items i
         WHERE i.settlement_id = v_result
           AND i.item_status = 'active'
      ) <> v_gross
      THEN
        RAISE EXCEPTION 'SETTLEMENT_ITEM_GROSS_MISMATCH';
      END IF;

      RETURN v_result;
    END;
    $function$;
