---
name: Duplicate review resolution
description: Duplicate bank matches need an explicit candidate choice or a manual COA approval path.
---

For non-QRIS duplicate-review mutations, the reviewer may either approve one persisted candidate or explicitly choose a manual COA. Manual COA approval must supersede remaining candidate suggestions in the same transaction.

**Why:** Blocking both candidate approval and COA selection leaves duplicate review records permanently stuck, while allowing candidates to remain actionable after manual approval risks a second posting path.

**How to apply:** Keep the approved-match guard and company/COA validation; expose both actions only when no match is already approved, and mark unresolved candidates superseded when manual COA approval succeeds.