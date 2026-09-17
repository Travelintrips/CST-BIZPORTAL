- [GCP API origin separation](gcp-api-origin.md) — the development secret currently has a frontend URL, so a separate backend API origin is required.
- [Production purchase proxy auth](production-purchase-proxy-auth.md) — OTP login must establish both local and upstream sessions because purchase routes have split ownership.
- [Production verification prerequisites](production-verification.md) — Replit production SQL and a published URL are unavailable until the app has a deployment.
- [Production API database DNS](production-api-database-dns.md) — the published API can serve the frontend while its production database host fails DNS resolution; check `/api/health/ready`.
- [Supabase pooler startup parameters](supabase-pooler-startup-parameters.md) — do not pass statement_timeout as a node-postgres pool startup option; Supabase pooler rejects it.
- [Replit API routing](replit-api-routing.md) — use same-origin `/api`; never pin an ephemeral `*.replit.dev` host in project config.
- [Vendor invoice payment settlement](vendor-invoice-payment-settlement.md) — AP Terbayar must come from final/posted reconciliation allocations, with legacy invoice totals excluded.
- [Post-merge configuration integrity](post-merge-config.md) — keep `.replit` schema-valid with one post-merge hook and no duplicate environment keys.
- [Vendor invoice candidate source](vendor-invoice-candidate-source.md) — bank reconciliation candidates must be served from local Supabase canonical allocations, not the legacy proxy.
- [Purchase workflow ownership](purchase-workflow-ownership.md) — purchase-workflow handlers and payment aggregation live in an external upstream service, not this proxy workspace.
- [Vendor invoice candidate source](vendor-invoice-candidate-source.md) — bank reconciliation candidates must be served from local Supabase canonical allocations, not the legacy proxy

- [QRIS reset audit history](qris-reset-audit-history.md) — read QRIS reset history from the server audit-log contract and include settlementDate in reset requests.

- [Sport Center draft idempotency](sport-center-draft-idempotency.md) — reversed historical payment journals require exact reversal validation and a draft-only unique index.
- [General ledger pagination semantics](general-ledger-pagination.md) — calculate running balances and totals over the full filtered set before applying display pagination.
- [General ledger filter test harness](general-ledger-filter-test-harness.md) — isolate Radix Select focus management when testing ledger filter behavior in jsdom.

- [Optional vendor withholding](optional-vendor-withholding.md) — zero PPh and empty withholding records are valid read states; do not load PPh accounts or mutate records on GET.
- [Bank reconciliation matcher ownership](bank-reconciliation-matcher-ownership.md) — candidate generation and server auto-post policy live upstream; proxy/UI changes cannot create missing candidates.

