---
name: Bank reconciliation read contract
description: Required local API read surface for displaying synced bank mutations in BizPortal.
---

The bank reconciliation UI depends on local read endpoints for the mutation list and status summary; successful Google Sheet sync and populated database rows do not make those rows visible by themselves.

**Why:** The production database contained synced mutations while the published standalone API returned 404 for the UI's list and summary requests, producing a misleading generic "server/schema" error.

**How to apply:** Before publishing reconciliation changes, verify the UI's list and summary routes against the same production-shaped schema, and keep the response fields aligned with the mutation and match tables.