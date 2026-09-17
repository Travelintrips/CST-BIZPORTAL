---
name: General ledger pagination semantics
description: Accounting rules for paginating the General Ledger without changing balances or report totals.
---

The General Ledger must calculate running balances chronologically over the complete filtered result set, and calculate debit, credit, count, and opening/closing summaries over that same unpaged set. Apply sorting and `LIMIT/OFFSET` only after those calculations.

**Why:** Applying pagination before the window calculations makes page two restart its balance and makes the summary depend on the visible page instead of the selected report period.

**How to apply:** Keep the ledger rows in a SQL CTE/window-function pipeline or an equivalent full-set calculation, then paginate the final ordered rows. Opening balances are scoped by account, company, branch, and division context.