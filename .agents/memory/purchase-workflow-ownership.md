---
name: Purchase workflow ownership
description: Boundary between the BizPortal proxy workspace and the external purchase-workflow service.
---

The BizPortal workspace only proxies purchase-workflow requests; it does not contain the upstream handlers, purchase schema, or payment tables. Canonical Bank Reconciliation payment aggregation and reset-payment blocking must be implemented and tested in the upstream service, not recreated in this proxy.

**Why:** The local API server forwards these routes to the configured upstream origin, so a local implementation would either be a disconnected fake or risk changing purchase accounting behavior.

**How to apply:** Before changing purchase payment behavior, verify that the upstream source or an explicit upstream contract is available. Keep local changes limited to consumer/contract tests and proxy behavior unless the upstream service is mounted into the workspace.

Vendor-invoice paths must remain an authentication boundary only and then fall through to the parent proxy. The proxy database may not contain `vendor_invoices`, liability-account, or withholding tables, and read fallbacks must not synthesize PPh records.

**Why:** Direct local handlers produced PostgreSQL `42P01` relation-not-found failures for invoice detail and liability-account reads, while the valid invoice data belongs to the upstream Purchase Workflow service.

**How to apply:** When adding or changing `/purchase-workflow/vendor-invoices/*`, preserve `next("router")` after auth and test invoice detail plus liability-account reads for no local DB calls or write statements.