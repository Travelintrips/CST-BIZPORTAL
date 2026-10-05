# Fleet data ownership audit

## Fleet-owned candidates

These tables are directly referenced by the current Fleet router and are candidates to move behind the standalone Fleet data layer:

- `fleet_accounting_journals`
- `fleet_alerts`
- `fleet_cash_payments`
- `fleet_daily_summary`
- `fleet_drivers`
- `fleet_expense_budgets`
- `fleet_expenses`
- `fleet_outstanding`
- `fleet_outstanding_import_log`
- `fleet_partners`
- `fleet_reconciliation_reports`
- `fleet_reports`
- `fleet_transactions`
- `fleet_vehicles`
- `fleet_wa_logs`
- `fleet_wa_worker_state`
- `gojek_failed_rows`
- `gojek_raw_transactions`

## Shared / external dependencies

The current router also reaches shared BizPortal/Central Finance data directly:

- `accounting_entries`
- `accounting_entry_lines`
- `accounting_journals`
- `accounting_settings`

This direct database coupling must be removed before Fleet is considered independently deployable.

### Target boundary

- `companies`: identity/company scope supplied by auth/identity contract; Fleet must not own the master company table.
- `accounting_settings`: read through Central Finance configuration contract.
- `accounting_journals`, `accounting_entries`, `accounting_entry_lines`: write/read only through Central Finance integration contract.
- Posted Central Finance journals remain immutable.
- Fleet-owned tables may initially remain in the same PostgreSQL cluster, but only Fleet code should own their migrations and writes.

## Migration safety

No table rename, move, delete, schema transfer, or production data copy is authorized by this extraction branch. The first standalone DEV version should point to DEV data only and prove parity before any production data-boundary migration.
