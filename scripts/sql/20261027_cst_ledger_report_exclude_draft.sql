-- Applied in CST Supabase PROD on 2026-10-27.
-- Scope: company_id 1 (CST) only. Other companies are unchanged.
-- Preserve both security_invoker=true and all existing view columns/grants.
-- A draft accounting entry must not count as a posted ledger transaction.
-- Immutable fleet_ledger_entries remain intact for audit and become visible
-- automatically when the parent accounting entry becomes POSTED.
--
-- Check after running:
-- SELECT count(*) FROM public.v_ledger_journal_view v
-- JOIN public.accounting_entries e ON e.entry_number=v.entry_number
--  AND e.company_id=v.company_id
-- WHERE v.company_id=1 AND e.status::text='draft'; -- MUST be 0
BEGIN;
CREATE OR REPLACE VIEW public.v_ledger_balance_view
WITH (security_invoker = true) AS
SELECT fle.company_id, fle.period, fle.account_id, fle.account_code,
       fle.account_name, fle.account_type,
       coalesce(sum(fle.debit),0)::numeric(14,2) AS total_debit,
       coalesce(sum(fle.credit),0)::numeric(14,2) AS total_credit,
       (coalesce(sum(fle.debit),0)-coalesce(sum(fle.credit),0))::numeric(14,2) AS net_balance,
       count(fle.id)::integer AS entry_count
FROM public.fleet_ledger_entries fle
WHERE fle.is_voided = false
  AND NOT (fle.company_id=1 AND EXISTS (
    SELECT 1 FROM public.accounting_entries ae
    WHERE ae.company_id=fle.company_id
      AND ae.entry_number=fle.source_ref
      AND ae.status::text='draft'
  ))
GROUP BY fle.company_id,fle.period,fle.account_id,fle.account_code,
         fle.account_name,fle.account_type;

CREATE OR REPLACE VIEW public.v_ledger_journal_view
WITH (security_invoker = true) AS
SELECT fle.company_id,fle.period,fle.ledger_date,fle.source_type,fle.source_id,
       fle.source_ref AS entry_number,fle.account_id,fle.account_code,
       fle.account_name,fle.account_type,
       sum(fle.debit) AS total_debit,sum(fle.credit) AS total_credit,
       count(fle.id) AS line_count
FROM public.fleet_ledger_entries fle
WHERE fle.is_voided = false
  AND NOT (fle.company_id=1 AND EXISTS (
    SELECT 1 FROM public.accounting_entries ae
    WHERE ae.company_id=fle.company_id
      AND ae.entry_number=fle.source_ref
      AND ae.status::text='draft'
  ))
GROUP BY fle.company_id,fle.period,fle.ledger_date,fle.source_type,fle.source_id,
         fle.source_ref,fle.account_id,fle.account_code,fle.account_name,fle.account_type;

COMMENT ON VIEW public.v_ledger_balance_view IS
'Ledger totals exclude CST company 1 draft accounting entries mirrored before posting. Immutable mirror rows are preserved; original security_invoker retained.';
COMMENT ON VIEW public.v_ledger_journal_view IS
'Ledger journal view excludes CST company 1 draft accounting entries mirrored before posting; preserves audit rows and security_invoker.';
COMMIT;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.v_ledger_journal_view v
    JOIN public.accounting_entries ae
      ON ae.company_id=v.company_id AND ae.entry_number=v.entry_number
    WHERE v.company_id=1 AND ae.status::text='draft'
  ) THEN
    RAISE EXCEPTION 'CST draft journals visible in reporting view';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid IN ('public.v_ledger_balance_view'::regclass,
                    'public.v_ledger_journal_view'::regclass)
      AND NOT ('security_invoker=true'=ANY(c.reloptions))
  ) THEN
    RAISE EXCEPTION 'Ledger view lost security_invoker';
  END IF;
END
$verify$;
