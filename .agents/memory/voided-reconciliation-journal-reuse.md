---
name: Voided reconciliation journal reuse
description: Accounting invariant for reopened bank mutations whose prior reconciliation journal was voided.
---

A reopened bank mutation must create a new draft journal when it is matched again. A voided journal is historical evidence and must never be returned as the active idempotent result.

**Why:** A vendor-invoice rematch reused a previously posted-and-voided journal because the accounting idempotency lookup treated the old source identity as active. The mutation moved to `approved_pending_posting` while its linked journal remained `voided`, hiding and blocking the posting action.

**How to apply:** Scope accounting idempotency to active entries or issue a new event identity after reversal. Preserve the old journal and its reversal, and require the replacement draft to have the new financial line signature before linking it to the mutation.