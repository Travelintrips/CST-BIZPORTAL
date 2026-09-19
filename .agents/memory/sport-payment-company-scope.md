---
name: Sport Center payment company scope
description: Legacy Sport Center payments without company_id are scoped to company 1 by bank matching and approval.
---

Legacy Sport Center payment rows can have a NULL company_id. Bank matching treats those rows as company 1, so approval validation must use the same `coalesce(company_id, 1)` scope.

**Why:** Otherwise a valid legacy payment candidate appears in reconciliation but is rejected as stale when the reviewer approves it.

**How to apply:** Keep candidate discovery and source revalidation on the same company-scope expression; do not broaden the fallback to other companies.