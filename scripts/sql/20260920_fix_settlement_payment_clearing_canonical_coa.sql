-- Canonicalize Sport Center QRIS settlement clearing COA.
-- Safe behavior:
--   * changes only the function definition for future settlement journals;
--   * leaves already-posted historical journals immutable;
--   * resolves the active company-scoped clearing account from public.chart_of_accounts;
--   * fails closed if the canonical clearing account is unavailable.
--
-- Pre-patch function MD5 in DEV/PROD on 2026-09-20:
--   a0dcd4df545a01b2bc87b9c56b09ad43
-- Post-patch function MD5:
--   d85cdfb92344bc1392e7ff991eb377db

DO $migration$
DECLARE
  v_definition text;
  v_oid oid;
BEGIN
  SELECT p.oid, pg_get_functiondef(p.oid)
    INTO v_oid, v_definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'sport_center'
     AND p.proname = 'create_settlement_journal_draft'
     AND p.prokind = 'f'
   LIMIT 1;

  IF v_oid IS NULL OR v_definition IS NULL THEN
    RAISE EXCEPTION 'CREATE_SETTLEMENT_JOURNAL_DRAFT_NOT_FOUND';
  END IF;

  -- Idempotent when the canonical patch is already installed.
  IF md5(v_definition) = 'd85cdfb92344bc1392e7ff991eb377db' THEN
    RETURN;
  END IF;

  IF md5(v_definition) <> 'a0dcd4df545a01b2bc87b9c56b09ad43' THEN
    RAISE EXCEPTION
      'CREATE_SETTLEMENT_JOURNAL_DRAFT_UNEXPECTED_DEFINITION: %',
      md5(v_definition);
  END IF;

  IF position('''1199''' in v_definition) = 0
     OR position('''Payment Clearing''' in v_definition) = 0
  THEN
    RAISE EXCEPTION 'LEGACY_PAYMENT_CLEARING_MARKERS_NOT_FOUND';
  END IF;

  v_definition := replace(
    v_definition,
    '    v_bank_account_name text;',
    E'    v_bank_account_name text;\n    v_clearing_account_code text;\n    v_clearing_account_name text;'
  );

  v_definition := replace(
    v_definition,
    '    -- CONDITIONAL COA VALIDATION',
    E'    -- CANONICAL PAYMENT CLEARING COA\n    -- Resolve by company from the shared public COA master.\n    SELECT coa.code, coa.name\n      INTO v_clearing_account_code, v_clearing_account_name\n      FROM public.chart_of_accounts coa\n     WHERE coa.company_id = v_settlement.company_id\n       AND coa.code LIKE ''1-1024-%''\n       AND coa.name ILIKE ''Payment Clearing Sport Center / QRIS%''\n       AND coa.account_category = ''ASSET''\n       AND coa.is_active = true\n       AND coalesce(coa.is_header, false) = false\n       AND coalesce(coa.is_postable, true) = true\n     ORDER BY coa.id\n     LIMIT 1;\n\n    IF v_clearing_account_code IS NULL OR v_clearing_account_name IS NULL THEN\n        RAISE EXCEPTION\n            ''PAYMENT_CLEARING_COA_NOT_FOUND_FOR_COMPANY: %'',\n            v_settlement.company_id;\n    END IF;\n\n    -- CONDITIONAL COA VALIDATION'
  );

  v_definition := replace(v_definition, '''1199''', 'v_clearing_account_code');
  v_definition := replace(v_definition, '''Payment Clearing''', 'v_clearing_account_name');

  IF position('''1199''' in v_definition) > 0
     OR position('''Payment Clearing''' in v_definition) > 0
  THEN
    RAISE EXCEPTION 'LEGACY_PAYMENT_CLEARING_MARKERS_REMAIN_AFTER_PATCH';
  END IF;

  EXECUTE v_definition;
END
$migration$;
