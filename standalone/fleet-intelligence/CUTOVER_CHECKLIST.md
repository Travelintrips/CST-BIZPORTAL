# Cutover checklist

No production cutover until every item below is green.

- [ ] Standalone frontend builds without importing BizPortal-only pages.
- [ ] Standalone Fleet API boots independently.
- [ ] DEV and PROD environment guards reject cross-environment credentials.
- [ ] Admin authentication and company scoping pass.
- [ ] Driver and vehicle totals match the embedded Fleet module on DEV fixtures.
- [ ] CSV preview/import/dedup/DLQ/reconciliation pass.
- [ ] Outstanding calculation matches the source data.
- [ ] WA tests use DEV/test recipients only.
- [ ] Fleet accounting preview balances debit = credit.
- [ ] Central Finance posting contract is idempotent and does not mutate posted journals.
- [ ] Destructive report purge/delete endpoints are role-gated and audited.
- [ ] DEV deployed at dev-fleet.cstlogistic.co.id.
- [ ] Parallel read-only comparison completed.
- [ ] Rollback path to embedded Fleet documented and tested.
- [ ] Only then provision/switch fleet.cstlogistic.co.id.
