---
name: Standalone approval database boundary
description: The local bank reconciliation approval route and the database prerequisite that remains outside the route implementation.
---

The standalone API owns bank reconciliation approval locally. Approval must lock the mutation, create or reuse one draft accounting entry, update the mutation and selected match, and write the audit row in one transaction; it must not call the upstream service.

**Why:** The BizPortal UI calls the local `/api/bank-reconciliation/:mutationId/approve` path, and approval can otherwise succeed partially or create duplicate journals under retries.

**How to apply:** Keep the route scoped to local `pg pool` and local auth. The root standalone database currently has no canonical reconciliation/accounting tables, so schema/data migration belongs in the project migration process before end-to-end approval can be tested with a real mutation; do not add request-time DDL.