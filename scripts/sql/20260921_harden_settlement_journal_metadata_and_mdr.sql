-- Harden Sport Center settlement journals against legacy COA/metadata drift.
-- Safe/idempotent:
-- * backfills only settlement journal header metadata from its canonical batch;
-- * preserves all posted debit/credit lines;
-- * upgrades create_settlement_journal_draft from post-clearing-patch MD5
--   d85cdfb92344bc1392e7ff991eb377db to
--   4d7994115d187c7a5fa4ecce6411d937;
-- * uses shared public COA 5-3050-CST for MDR;
-- * optional fee/tax/adjustment legacy codes must exist in public COA or fail closed.

UPDATE sport_center.accounting_journals j
   SET settlement_reference = b.settlement_reference,
       settlement_date = b.settlement_date,
       bank_account_id = b.bank_account_id,
       provider_name = b.provider_name,
       settlement_status = b.status::text,
       mdr_amount = b.mdr_amount,
       updated_at = now()
  FROM sport_center.payment_settlement_batches b
 WHERE j.journal_type = 'settlement'
   AND j.is_reversal = false
   AND j.settlement_batch_id = b.id
   AND (
     j.settlement_reference IS DISTINCT FROM b.settlement_reference
     OR j.settlement_date IS DISTINCT FROM b.settlement_date
     OR j.bank_account_id IS DISTINCT FROM b.bank_account_id
     OR j.provider_name IS DISTINCT FROM b.provider_name
     OR j.settlement_status IS DISTINCT FROM b.status::text
     OR j.mdr_amount IS DISTINCT FROM b.mdr_amount
   );

DO $migration$
DECLARE
  v_definition text;
  v_old text;
  v_md5 text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'sport_center'
     AND p.proname = 'create_settlement_journal_draft'
     AND p.prokind = 'f'
   LIMIT 1;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'CREATE_SETTLEMENT_JOURNAL_DRAFT_NOT_FOUND';
  END IF;

  v_md5 := md5(v_definition);

  IF v_md5 = '4d7994115d187c7a5fa4ecce6411d937' THEN
    RETURN;
  END IF;

  IF v_md5 <> 'd85cdfb92344bc1392e7ff991eb377db' THEN
    RAISE EXCEPTION 'UNEXPECTED_CREATE_SETTLEMENT_FUNCTION_MD5: %', v_md5;
  END IF;

  v_definition := replace(
    v_definition,
    '    v_clearing_account_name text;',
    E'    v_clearing_account_name text;\n    v_mdr_account_code text;\n    v_mdr_account_name text;'
  );

  v_old := E'    IF v_settlement.mdr_amount > 0\r\n       AND NOT EXISTS (\r\n            SELECT 1\r\n            FROM sport_center.coa_accounts\r\n            WHERE code = ''61.16''\r\n              AND account_type::text = ''expense''\r\n              AND is_active = true\r\n       ) THEN\r\n\r\n        RAISE EXCEPTION\r\n            ''MDR_EXPENSE_COA_NOT_FOUND: 61.16'';\r\n\r\n    END IF;';

  IF position(v_old in v_definition) = 0 THEN
    RAISE EXCEPTION 'LEGACY_MDR_VALIDATION_BLOCK_NOT_FOUND';
  END IF;

  v_definition := replace(
    v_definition,
    v_old,
    E'    IF v_settlement.mdr_amount > 0 THEN\r\n        SELECT coa.code, coa.name\r\n          INTO v_mdr_account_code, v_mdr_account_name\r\n          FROM public.chart_of_accounts coa\r\n         WHERE coa.company_id = v_settlement.company_id\r\n           AND coa.code = ''5-3050-CST''\r\n           AND coa.account_category = ''EXPENSE''\r\n           AND coa.is_active = true\r\n           AND coalesce(coa.is_header, false) = false\r\n           AND coalesce(coa.is_postable, true) = true\r\n         LIMIT 1;\r\n\r\n        IF v_mdr_account_code IS NULL OR v_mdr_account_name IS NULL THEN\r\n            RAISE EXCEPTION ''MDR_EXPENSE_COA_NOT_FOUND_FOR_COMPANY: %'', v_settlement.company_id;\r\n        END IF;\r\n    END IF;'
  );

  v_definition := replace(
    v_definition,
    E'            ''61.16'',\r\n            ''Beban MDR'',',
    E'            v_mdr_account_code,\r\n            v_mdr_account_name,'
  );

  FOREACH v_old IN ARRAY ARRAY['61.17','61.18','61.19','1198']
  LOOP
    v_definition := replace(
      v_definition,
      E'            FROM sport_center.coa_accounts\r\n\r\n            WHERE code = ''' || v_old || E'''',
      E'            FROM public.chart_of_accounts\r\n\r\n            WHERE company_id = v_settlement.company_id\r\n              AND code = ''' || v_old || E''''
    );
  END LOOP;

  v_old := E'    RETURNING id\r\n      INTO v_journal_id;';

  IF position(v_old in v_definition) = 0 THEN
    RAISE EXCEPTION 'RETURNING_BLOCK_NOT_FOUND';
  END IF;

  v_definition := replace(
    v_definition,
    v_old,
    E'    RETURNING id\r\n      INTO v_journal_id;\r\n\r\n    UPDATE sport_center.accounting_journals\r\n       SET settlement_reference = v_settlement.settlement_reference,\r\n           settlement_date = v_settlement.settlement_date,\r\n           bank_account_id = v_settlement.bank_account_id,\r\n           provider_name = v_settlement.provider_name,\r\n           settlement_status = v_settlement.status::text,\r\n           mdr_amount = v_settlement.mdr_amount,\r\n           updated_at = now()\r\n     WHERE id = v_journal_id;'
  );

  IF position('v_mdr_account_code' in v_definition) = 0
     OR position('settlement_reference = v_settlement.settlement_reference' in v_definition) = 0
     OR position(E'            ''61.16'',\r\n            ''Beban MDR'',' in v_definition) > 0
  THEN
    RAISE EXCEPTION 'CANONICAL_SETTLEMENT_PATCH_NOT_APPLIED';
  END IF;

  EXECUTE v_definition;

  IF md5((
    SELECT pg_get_functiondef(p.oid)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'sport_center'
      AND p.proname = 'create_settlement_journal_draft'
      AND p.prokind = 'f'
    LIMIT 1
  )) <> '4d7994115d187c7a5fa4ecce6411d937' THEN
    RAISE EXCEPTION 'CANONICAL_SETTLEMENT_PATCH_MD5_MISMATCH';
  END IF;
END
$migration$;
