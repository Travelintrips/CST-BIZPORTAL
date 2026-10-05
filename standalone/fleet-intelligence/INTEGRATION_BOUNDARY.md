# Integration boundary

## Fleet owns
Fleet partners, drivers, vehicles, reports, transactions, outstanding, raw Gojek ingestion, DLQ/pipeline and Fleet validation data.

## Shared/external
- Company/admin identity
- Central Finance ledger and COA
- WA Gateway
- AI Core (optional)

## Rules
- Every request must have authenticated user/admin context plus company scope.
- Fleet does not directly mutate posted Central Finance journals.
- Accounting writes require idempotency.
- DEV must never use PROD database or real production WA recipients.
