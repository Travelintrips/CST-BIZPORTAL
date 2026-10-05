# Fleet API inventory

Generated from the current BizPortal Fleet router. This is the compatibility contract to preserve during extraction.

- `GET /api/logistics/fleet/accounting/journals`
- `PUT /api/logistics/fleet/accounting/journals/:id/approve`
- `PUT /api/logistics/fleet/accounting/journals/:id/post`
- `POST /api/logistics/fleet/accounting/journals/generate`
- `GET /api/logistics/fleet/alerts`
- `PUT /api/logistics/fleet/alerts/:id/read`
- `PUT /api/logistics/fleet/alerts/read-all`
- `GET /api/logistics/fleet/analytics`
- `GET /api/logistics/fleet/analytics/churn-risk`
- `GET /api/logistics/fleet/analytics/forecast`
- `GET /api/logistics/fleet/analytics/idle-vehicles`
- `GET /api/logistics/fleet/cash-payments`
- `POST /api/logistics/fleet/cash-payments`
- `PATCH /api/logistics/fleet/cash-payments/:id/cancel`
- `GET /api/logistics/fleet/cash-payments/summary`
- `GET /api/logistics/fleet/dashboard`
- `GET /api/logistics/fleet/drivers`
- `GET /api/logistics/fleet/drivers/:extId/detail`
- `PUT /api/logistics/fleet/drivers/:id`
- `GET /api/logistics/fleet/executive-summary`
- `GET /api/logistics/fleet/expenses`
- `POST /api/logistics/fleet/expenses`
- `DELETE /api/logistics/fleet/expenses/:id`
- `PUT /api/logistics/fleet/expenses/:id`
- `GET /api/logistics/fleet/expenses/budgets`
- `POST /api/logistics/fleet/expenses/budgets`
- `DELETE /api/logistics/fleet/expenses/budgets/:id`
- `GET /api/logistics/fleet/ledger`
- `GET /api/logistics/fleet/outstanding`
- `DELETE /api/logistics/fleet/outstanding/:id`
- `POST /api/logistics/fleet/outstanding/:id/followup`
- `PUT /api/logistics/fleet/outstanding/:id/resolve`
- `POST /api/logistics/fleet/outstanding/:id/wa`
- `GET /api/logistics/fleet/outstanding/auto-blast-settings`
- `PUT /api/logistics/fleet/outstanding/auto-blast-settings`
- `GET /api/logistics/fleet/outstanding/import-log`
- `GET /api/logistics/fleet/outstanding/macet`
- `POST /api/logistics/fleet/outstanding/repair`
- `POST /api/logistics/fleet/outstanding/snapshot/confirm`
- `POST /api/logistics/fleet/outstanding/snapshot/preview`
- `POST /api/logistics/fleet/outstanding/wa-blast`
- `GET /api/logistics/fleet/outstanding/wa-logs`
- `POST /api/logistics/fleet/outstanding/wa-reminder`
- `GET /api/logistics/fleet/outstanding/wa-worker-state`
- `GET /api/logistics/fleet/partners`
- `GET /api/logistics/fleet/pipeline/dlq`
- `POST /api/logistics/fleet/pipeline/dlq/:id/retry`
- `POST /api/logistics/fleet/pipeline/dlq/resolve-all/:reportId`
- `GET /api/logistics/fleet/pipeline/export-csv`
- `GET /api/logistics/fleet/pipeline/monitor`
- `POST /api/logistics/fleet/pipeline/reconcile`
- `GET /api/logistics/fleet/reports`
- `DELETE /api/logistics/fleet/reports/:id`
- `GET /api/logistics/fleet/reports/:id/progress`
- `POST /api/logistics/fleet/reports/:id/purge`
- `POST /api/logistics/fleet/reports/preview`
- `POST /api/logistics/fleet/reports/purge-all`
- `POST /api/logistics/fleet/reports/upload`
- `GET /api/logistics/fleet/row-diff`
- `GET /api/logistics/fleet/row-diff/reports`
- `GET /api/logistics/fleet/settings`
- `PUT /api/logistics/fleet/settings`
- `GET /api/logistics/fleet/system-overview`
- `GET /api/logistics/fleet/transactions`
- `GET /api/logistics/fleet/validation/report`
- `GET /api/logistics/fleet/vehicles`
- `POST /api/logistics/fleet/vehicles`

## Rule

During DEV extraction, existing route semantics remain the reference. Breaking route changes require an explicit compatibility layer or versioned endpoint.
