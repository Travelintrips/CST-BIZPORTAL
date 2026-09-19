---
name: Manual COA company context
description: Manual bank-reconciliation COA approval must retain the reviewer’s validated company context for legacy imported rows.
---

Manual COA approval must use the authenticated, permission-checked company context when a legacy imported bank mutation has no `company_id`. The selected COA may be company-specific even though the mutation row is not.

**Why:** The COA picker is company-scoped, but imported bank rows can retain a NULL company_id; resolving the approval only from the mutation row makes a valid company COA appear invalid during journal creation.

**How to apply:** Send the active company context with manual approval requests, resolve it through the existing company-isolation guard, and use it only as a fallback when the mutation itself has no company.