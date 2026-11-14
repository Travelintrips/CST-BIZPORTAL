-- Issue #292: finance E2E readiness evidence, SELECT-only.
-- Run separately against CST-DEV and PROD; never executes settlement functions.
-- This query intentionally reports blockers rather than changing a DB role,
-- seeding shared DEV data, approving a match, or touching posted journals.
WITH
  functions AS (
    SELECT count(*)::int AS count,
           count(*) FILTER(WHERE p.prosecdef=true)::int AS definer_count
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='sport_center' AND p.proname IN (
       'canonical_settlement_group_identity',
       'create_payment_settlement_batch',
       'create_payment_settlement_batch_legacy',
       'create_payment_settlement_supplemental_batch',
       'calculate_settlement_mdr',
       'resolve_payment_settlement_config',
       'create_settlement_journal_draft',
       'validate_accounting_journal',
       'finalize_payment_settlement',
       'finalize_payment_settlement_legacy',
       'mark_settlement_payments_settled')
  ),
  rules AS (
    SELECT d.day,
           count(c.id)::int AS active_count,
           count(c.id) FILTER(WHERE
             c.rule_version='PROD-MANDIRI-SC-20260831-v1'
             AND c.mdr_rate=0.007
             AND c.calculation_method='percentage_of_gross'
             AND coalesce(c.fixed_provider_fee,0)=0
             AND coalesce(c.fee_tax_rate,0)=0
             AND c.rounding_scale=2 AND c.rounding_method='round_half_up'
           )::int AS exact_count
      FROM (VALUES (DATE '2026-11-04'),(DATE '2026-11-05')) d(day)
      LEFT JOIN sport_center.payment_settlement_configs c
        ON c.company_id=1 AND lower(c.provider_code)='mandiri_direct'
       AND c.bank_account_id='1640006707220'
       AND c.source='OWNER_APPROVED' AND c.is_active=true
       AND c.effective_from<=d.day
       AND (c.effective_until IS NULL OR d.day<c.effective_until)
     GROUP BY d.day
  ),
  original AS (
    SELECT count(*)::int AS n
      FROM sport_center.payment_settlement_batches b
      JOIN sport_center.accounting_journals j ON j.id=b.settlement_journal_id
     WHERE b.id=5738 AND b.company_id=1 AND b.status='posted'
       AND b.settlement_journal_id=7207 AND j.status='posted'
       AND j.is_reversal=false
       AND b.net_amount=923700 AND b.gross_amount=930000 AND b.mdr_amount=6300
  ),
  bank AS (
    SELECT count(*)::int AS n
      FROM public.bank_mutations m
      JOIN public.company_bank_accounts ba ON ba.id::text=m.bank_account_id
     WHERE m.company_id=1 AND ba.company_id=1 AND ba.is_active=true
       AND ba.account_number='1640006707220'
       AND m.source_classification='actual_bank_mutation' AND m.direction='IN'
       AND m.journal_entry_id IS NULL AND m.approved_at IS NULL AND m.posted_at IS NULL
       AND ((m.id=434462 AND m.transaction_date='2026-11-04' AND m.amount=685800 AND m.status='unmatched')
         OR (m.id=434464 AND m.transaction_date='2026-11-05' AND m.amount=923700 AND m.status='matched'))
  ),
  payments AS (
    SELECT ((p.paid_at AT TIME ZONE 'Asia/Jakarta')::date+1) AS day,
           count(*)::int AS n,
           coalesce(sum(p.amount),0) AS gross,
           coalesce(sum(p.mdr_amount),0) AS mdr,
           bool_and(p.status='confirmed'
             AND lower(p.payment_method::text)='qris'
             AND lower(p.payment_provider::text)='mandiri_direct'
             AND p.company_id=1 AND p.bank_account_id='1640006707220'
             AND p.expected_settlement_date=((p.paid_at AT TIME ZONE 'Asia/Jakarta')::date+1)
             AND p.settlement_rule_version='PROD-MANDIRI-SC-20260831-v1') AS eligible
      FROM sport_center.sport_payments p
     WHERE p.id IN (834,843,853,856,858,859,860,861,862)
     GROUP BY 1
  ),
  approvals AS (
    SELECT count(*)::int AS n
      FROM public.bank_reconciliation_matches
     WHERE mutation_id IN (434462,434464) AND status='approved'
  ),
  roles AS (
    SELECT coalesce(bool_or(r.rolcanlogin AND
      has_function_privilege(r.oid,
        'sport_center.create_payment_settlement_batch(text,integer,text,text,date,integer[],text)',
        'EXECUTE') AND
      has_function_privilege(r.oid,
        'sport_center.create_payment_settlement_supplemental_batch(integer,text,text,date,text,integer[],text)',
        'EXECUTE') AND
      has_function_privilege(r.oid,
        'sport_center.create_settlement_journal_draft(bigint,text,text)',
        'EXECUTE') AND
      has_function_privilege(r.oid,
        'sport_center.finalize_payment_settlement(bigint,text)',
        'EXECUTE')),false) AS application_eligible
      FROM pg_roles r WHERE r.rolname='sport_center_app'
  )
SELECT 'issue292_readiness' AS report,
       (SELECT count=11 FROM functions) AS functions_present,
       (SELECT bool_and(active_count=1 AND exact_count=1) FROM rules) AS owner_rule_ready,
       (SELECT n=1 FROM original) AS original_posted,
       (SELECT n=2 FROM bank) AS bank_sources_ready,
       (SELECT count(*)=2
          AND bool_and(
            (day='2026-11-04' AND n=5 AND gross=690000 AND mdr=4200)
            OR (day='2026-11-05' AND n=4 AND gross=930000 AND mdr=6300)
          ) AND bool_and(coalesce(eligible,false))
        FROM payments) AS payment_cohorts_ready,
       (SELECT n=0 FROM approvals) AS no_approved_match,
       (SELECT application_eligible FROM roles) AS scoped_login_ready;
