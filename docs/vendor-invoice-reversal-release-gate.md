# Vendor Invoice reversal — pre-release accounting gate (2026-10-26)

Status: **BLOCKED for production**. PR #197 is a draft. Source-contract tests are not transaction E2E tests.

## Required period policy
A posted reversal is a **new journal on its own posting date**. For an original posted in July and a reversal posted in October, July's historical P&L must retain the original entry; October's P&L must include the reversing entry. Cumulative trial balance and balance sheet include both entries, so the pair nets to zero. The general ledger retains both rows with linked audit identifiers. Do not delete, backdate, or omit the original merely because it is marked reversed/voided.

## Read-only preflight queries
Run separately on DEV and PROD; record company, row counts and per-account differences before considering a migration.

```sql
-- Verify the five startup-migrated view definitions; review dependencies and grants separately.
SELECT schemaname, viewname, definition
FROM pg_views
WHERE schemaname = 'public'
  AND viewname IN ('accounting_general_ledger_v','accounting_trial_balance_v',
                   'accounting_profit_loss_v','accounting_balance_sheet_v','accounting_payments_v')
ORDER BY viewname;

-- Reversal pair financial neutrality, grouped by company and account.
-- A nonzero value means an existing reversal pair is not balanced on that account.
WITH pairs AS (
  SELECT o.id original_id, r.id reversal_id, o.company_id
  FROM accounting_entries o
  JOIN accounting_entries r ON r.id = o.void_entry_id
    AND r.company_id = o.company_id AND r.status = 'posted'
  WHERE o.is_reversed IS TRUE
), paired_lines AS (
  SELECT p.company_id, p.original_id, l.account_id, l.debit, l.credit
  FROM pairs p JOIN accounting_entry_lines l ON l.entry_id = p.original_id
  UNION ALL
  SELECT p.company_id, p.original_id, l.account_id, l.debit, l.credit
  FROM pairs p JOIN accounting_entry_lines l ON l.entry_id = p.reversal_id
)
SELECT company_id, original_id, account_id,
       SUM(debit - credit) AS residual
FROM paired_lines
GROUP BY company_id, original_id, account_id
HAVING ABS(SUM(debit - credit)) > 0.01
ORDER BY company_id, original_id, account_id;
```

## E2E acceptance criteria (isolated disposable database only)
1. Post a balanced synthetic Vendor Invoice and verify the four reporting views and general ledger before reversal.
2. Simulate unpaid, paid, bank-linked and reconciliation-linked invoices; only the unpaid/unlinked case may proceed.
3. Run two concurrent reversal requests; exactly one reversal journal is posted, with a consistent response to the other request.
4. Inject an error after reversal journal creation but before invoice update; the transaction must roll back every journal, line and invoice mutation.
5. Verify exact account-level debit/credit swap, company isolation, journal identity and idempotent retry.
6. Include same-month and cross-month reversal fixtures; validate historical P&L and cumulative balances.
7. Test both current PROD view semantics and proposed corrected views against a captured baseline; confirm existing non-reversal totals are unchanged.
8. Require finance approval of withholding classifications for AP2 invoice 8 and replacement 19 before any real posting.

## Release criteria
Do not remove the `vendor_invoice_reversal_pair` fail-closed gate merely to make the endpoint run. Replace it only with a verified, versioned migration and a robust schema/version check. No merge or production deployment until integration tests and finance/report reconciliations PASS.
