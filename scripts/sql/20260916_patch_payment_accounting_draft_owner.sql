-- Patch sport_center.create_payment_accounting_draft_owner idempotency.
--
-- This migration intentionally changes only the function definition. It does
-- not update, delete, or repair historical journals. Besides the idempotency
-- guards, it canonicalizes the function's COA classification so future retries
-- cannot restore legacy symbolic codes or classify provider=unknown as QRIS.

BEGIN;

DO $migration$
DECLARE
    v_definition text;
    v_declaration_marker text := '        v_existing_journal_id integer;' || chr(10);
    v_declaration_insert text :=
        '        v_existing_journal_id integer;' || chr(10) ||
        '        v_existing_journal_reversal_count integer;' || chr(10) ||
        '        v_valid_journal_reversal_count integer;' || chr(10) ||
        '        v_reversed_canonical_journal_found boolean := false;' || chr(10);
    v_start integer;
    v_end integer;
    v_new_block text := $patch$
        -- --------------------------------------------------------
        -- Canonical journal idempotency.
        --
        -- A payment_confirmed journal may be reused only while it has
        -- no reversal. A reversal is trusted only when it is exactly one
        -- posted, balanced, line-for-line opposite of the source journal.
        -- Any malformed or duplicate reversal fails closed.
        -- --------------------------------------------------------

        FOR v_existing_journal_id IN
            SELECT id
              FROM sport_center.accounting_journals
             WHERE payment_id = p_payment_id
               AND journal_type = 'payment_confirmed'
               AND is_reversal = false
             ORDER BY id
        LOOP
            SELECT
                COUNT(*)::integer,
                COUNT(*) FILTER (
                    WHERE r.status = 'posted'
                      AND r.is_reversal IS TRUE
                      AND r.journal_type = 'reversal'
                      AND (
                          SELECT COUNT(*)
                            FROM sport_center.accounting_journal_lines rl
                           WHERE rl.journal_id = r.id
                      ) = (
                          SELECT COUNT(*)
                            FROM sport_center.accounting_journal_lines sl
                           WHERE sl.journal_id = v_existing_journal_id
                      )
                      AND COALESCE((
                          SELECT SUM(rl.amount)
                            FROM sport_center.accounting_journal_lines rl
                           WHERE rl.journal_id = r.id
                      ), 0) = COALESCE((
                          SELECT SUM(sl.amount)
                            FROM sport_center.accounting_journal_lines sl
                           WHERE sl.journal_id = v_existing_journal_id
                      ), 0)
                      AND COALESCE((
                          SELECT SUM(rl.amount)
                            FROM sport_center.accounting_journal_lines rl
                           WHERE rl.journal_id = r.id
                             AND rl.line_type = 'debit'
                      ), 0) = COALESCE((
                          SELECT SUM(rl.amount)
                            FROM sport_center.accounting_journal_lines rl
                           WHERE rl.journal_id = r.id
                             AND rl.line_type = 'credit'
                      ), 0)
                      AND NOT EXISTS (
                          SELECT 1
                            FROM (
                                SELECT
                                    sl.line_type,
                                    sl.account_code,
                                    sl.account_name,
                                    sl.amount,
                                    COUNT(*) AS line_count
                                  FROM sport_center.accounting_journal_lines sl
                                 WHERE sl.journal_id = v_existing_journal_id
                                 GROUP BY
                                    sl.line_type,
                                    sl.account_code,
                                    sl.account_name,
                                    sl.amount
                                EXCEPT
                                SELECT
                                    CASE rl.line_type
                                        WHEN 'debit' THEN 'credit'
                                        WHEN 'credit' THEN 'debit'
                                    END,
                                    rl.account_code,
                                    rl.account_name,
                                    rl.amount,
                                    COUNT(*) AS line_count
                                  FROM sport_center.accounting_journal_lines rl
                                 WHERE rl.journal_id = r.id
                                 GROUP BY
                                    rl.line_type,
                                    rl.account_code,
                                    rl.account_name,
                                    rl.amount
                            ) source_lines_missing_from_reversal
                      )
                      AND NOT EXISTS (
                          SELECT 1
                            FROM (
                                SELECT
                                    CASE rl.line_type
                                        WHEN 'debit' THEN 'credit'
                                        WHEN 'credit' THEN 'debit'
                                    END AS line_type,
                                    rl.account_code,
                                    rl.account_name,
                                    rl.amount,
                                    COUNT(*) AS line_count
                                  FROM sport_center.accounting_journal_lines rl
                                 WHERE rl.journal_id = r.id
                                 GROUP BY
                                    rl.line_type,
                                    rl.account_code,
                                    rl.account_name,
                                    rl.amount
                                EXCEPT
                                SELECT
                                    sl.line_type,
                                    sl.account_code,
                                    sl.account_name,
                                    sl.amount,
                                    COUNT(*) AS line_count
                                  FROM sport_center.accounting_journal_lines sl
                                 WHERE sl.journal_id = v_existing_journal_id
                                 GROUP BY
                                    sl.line_type,
                                    sl.account_code,
                                    sl.account_name,
                                    sl.amount
                            ) reversal_lines_missing_from_source
                      )
                )::integer
              INTO
                v_existing_journal_reversal_count,
                v_valid_journal_reversal_count
              FROM sport_center.accounting_journals r
             WHERE r.reversal_of_id = v_existing_journal_id;

            IF v_existing_journal_reversal_count = 0 THEN
                IF EXISTS (
                    SELECT 1
                      FROM sport_center.accounting_journals existing_journal
                     WHERE existing_journal.id = v_existing_journal_id
                       AND (
                           ABS(COALESCE(existing_journal.gross_amount, -1)::numeric - ROUND(v_payment.amount::numeric, 2)) > 0.01
                           OR ABS(COALESCE(existing_journal.debit_amount, -1)::numeric - ROUND(v_payment.amount::numeric, 2)) > 0.01
                           OR ABS((COALESCE(existing_journal.credit_revenue_amount, 0) + COALESCE(existing_journal.credit_ppn_amount, 0))::numeric - ROUND(v_payment.amount::numeric, 2)) > 0.01
                           OR ABS(COALESCE((SELECT SUM(line.amount) FROM sport_center.accounting_journal_lines line WHERE line.journal_id = existing_journal.id AND line.line_type = 'debit'), -1)::numeric - ROUND(v_payment.amount::numeric, 2)) > 0.01
                           OR ABS(COALESCE((SELECT SUM(line.amount) FROM sport_center.accounting_journal_lines line WHERE line.journal_id = existing_journal.id AND line.line_type = 'credit'), -1)::numeric - ROUND(v_payment.amount::numeric, 2)) > 0.01
                       )
                ) THEN
                    RAISE EXCEPTION
                        'PAYMENT_ACCOUNTING_EXISTING_JOURNAL_AMOUNT_MISMATCH: payment=% journal=% payment_amount=%',
                        p_payment_id,
                        v_existing_journal_id,
                        v_payment.amount;
                END IF;
                RETURN v_existing_journal_id;
            END IF;

            IF v_existing_journal_reversal_count <> 1
               OR v_valid_journal_reversal_count <> 1
            THEN
                RAISE EXCEPTION
                    'PAYMENT_CONFIRMATION_REVERSAL_INVALID: payment=% journal=% reversal_count=% valid_reversal_count=%',
                    p_payment_id,
                    v_existing_journal_id,
                    v_existing_journal_reversal_count,
                    v_valid_journal_reversal_count;
            END IF;

            v_reversed_canonical_journal_found := true;
        END LOOP;

        -- --------------------------------------------------------
        -- Canonical accounting idempotency.
        $patch$;
BEGIN
    SELECT pg_get_functiondef(p.oid)
      INTO v_definition
      FROM pg_proc p
      JOIN pg_namespace n
        ON n.oid = p.pronamespace
     WHERE n.nspname = 'sport_center'
       AND p.proname = 'create_payment_accounting_draft_owner'
       AND pg_get_function_identity_arguments(p.oid)
           = 'p_payment_id integer, p_legacy_public_entry_id integer';

    IF v_definition IS NULL THEN
        RAISE EXCEPTION
            'PAYMENT_ACCOUNTING_DRAFT_OWNER_NOT_FOUND';
    END IF;

    IF strpos(v_definition, v_declaration_marker) = 0 THEN
        RAISE EXCEPTION
            'PAYMENT_ACCOUNTING_DRAFT_OWNER_DECLARATION_MARKER_NOT_FOUND';
    END IF;

    IF strpos(v_definition, 'v_reversed_canonical_journal_found boolean') = 0 THEN
        v_definition := replace(
            v_definition,
            v_declaration_marker,
            v_declaration_insert
        );
    END IF;

    v_start := strpos(
        v_definition,
        '        -- Canonical journal idempotency.'
    );
    v_end :=
        v_start - 1
        + strpos(
            substr(v_definition, v_start),
            '        -- Canonical accounting idempotency.'
        );

    IF v_start = 0 OR v_end = 0 OR v_end <= v_start THEN
        RAISE EXCEPTION
            'PAYMENT_ACCOUNTING_DRAFT_OWNER_IDEMPOTENCY_MARKERS_NOT_FOUND';
    END IF;

    v_definition :=
        left(v_definition, v_start - 1)
        || v_new_block
        || substr(v_definition, v_end);

    -- When a canonical payment_confirmed journal has a valid reversal, its
    -- legacy public projection is historical as well. Do not let that stale
    -- projection block creation of the new current-payment draft.
    v_definition := replace(
        v_definition,
        '        IF v_existing_accounting_payment_id IS NOT NULL' || chr(10) ||
        '           OR v_existing_accounting_entry_id IS NOT NULL' || chr(10) ||
        '        THEN',
        '        IF NOT v_reversed_canonical_journal_found' || chr(10) ||
        '           AND (' || chr(10) ||
        '               v_existing_accounting_payment_id IS NOT NULL' || chr(10) ||
        '               OR v_existing_accounting_entry_id IS NOT NULL' || chr(10) ||
        '           )' || chr(10) ||
        '        THEN'
    );

    IF strpos(v_definition, 'v_reversed_canonical_journal_found') = 0 THEN
        RAISE EXCEPTION
            'PAYMENT_ACCOUNTING_DRAFT_OWNER_PUBLIC_IDEMPOTENCY_MARKER_NOT_FOUND';
    END IF;

    -- Canonical COA classification. These replacements are deliberately
    -- marker-driven and fail closed if the expected legacy source changes.
    IF strpos(v_definition, 'v_revenue_account_code text := ''REVENUE'';') = 0
       OR strpos(v_definition, 'OR v_payment_provider IS NOT NULL') = 0
       OR strpos(v_definition, '''PAYMENT_CLEARING''') = 0
    THEN
        RAISE EXCEPTION
            'PAYMENT_ACCOUNTING_DRAFT_OWNER_CANONICAL_MARKERS_NOT_FOUND';
    END IF;

    v_definition := replace(
        v_definition,
        'v_revenue_account_code text := ''REVENUE'';',
        'v_revenue_account_code text := ''4-1017-CST'';'
    );
    v_definition := replace(
        v_definition,
        'v_revenue_account_name text := ''Pendapatan Sport Center'';',
        'v_revenue_account_name text := ''Pendapatan Booking Sport Center CST'';'
    );
    v_definition := replace(
        v_definition,
        'v_tax_account_code text := ''PPN_OUTPUT'';',
        'v_tax_account_code text := ''2-1020-CST'';'
    );
    v_definition := replace(
        v_definition,
        'v_tax_account_name text := ''PPN Keluaran'';',
        'v_tax_account_name text := ''PPN Keluaran CST'';'
    );
    v_definition := replace(
        v_definition,
        'OR v_payment_provider IS NOT NULL',
        'OR lower(coalesce(v_payment_provider, '''')) NOT IN ('''', ''unknown'', ''manual'')'
    );
    v_definition := replace(v_definition, '''PAYMENT_CLEARING''', '''1-1024-CST''');
    v_definition := replace(v_definition, '''Payment Clearing''', '''Payment Clearing Sport Center / QRIS CST''');
    v_definition := replace(v_definition, '''CASH''', '''1-1010-CST''');
    v_definition := replace(v_definition, '''Kas''', '''Kas Besar CST''');
    v_definition := replace(v_definition, '''BANK_RECEIPT''', '''1-1023-CST''');
    v_definition := replace(v_definition, '''Bank / Kas Masuk''', '''Bank Mandiri Ciputat''');

    IF strpos(v_definition, '''REVENUE''') > 0
       OR strpos(v_definition, '''PPN_OUTPUT''') > 0
       OR strpos(v_definition, '''PAYMENT_CLEARING''') > 0
       OR strpos(v_definition, '''BANK_RECEIPT''') > 0
       OR strpos(v_definition, 'OR v_payment_provider IS NOT NULL') > 0
    THEN
        RAISE EXCEPTION
            'PAYMENT_ACCOUNTING_DRAFT_OWNER_LEGACY_COA_MARKERS_REMAIN';
    END IF;

    EXECUTE v_definition;
END;
$migration$;

-- The old index cannot express "unless this journal has a valid reversal"
-- because PostgreSQL indexes cannot inspect another table. Keep the
-- concurrency/idempotency guarantee for active drafts while allowing a
-- reversed historical posting and its replacement draft to share payment_id.
DROP INDEX IF EXISTS sport_center.accounting_journals_payment_confirmed_unique;
CREATE UNIQUE INDEX accounting_journals_payment_confirmed_draft_unique
    ON sport_center.accounting_journals (payment_id)
    WHERE payment_id IS NOT NULL
      AND journal_type = 'payment_confirmed'
      AND is_reversal = false
      AND status = 'draft';

COMMIT;