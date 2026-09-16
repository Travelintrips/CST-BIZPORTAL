---
name: Purchase workflow ownership
description: Boundary between the BizPortal proxy workspace and the external purchase-workflow service.
---

The BizPortal workspace only proxies purchase-workflow requests; it does not contain the upstream handlers, purchase schema, or payment tables. Canonical Bank Reconciliation payment aggregation and reset-payment blocking must be implemented and tested in the upstream service, not recreated in this proxy.

**Why:** The local API server forwards these routes to the configured upstream origin, so a local implementation would either be a disconnected fake or risk changing purchase accounting behavior.

**How to apply:** Before changing purchase payment behavior, verify that the upstream source or an explicit upstream contract is available. Keep local changes limited to consumer/contract tests and proxy behavior unless the upstream service is mounted into the workspace.