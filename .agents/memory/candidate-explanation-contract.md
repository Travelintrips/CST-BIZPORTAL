---
name: Bank reconciliation candidate explanation
description: Candidate cards must explain matching evidence even when source details are absent.
---

The bank reconciliation candidate list can contain only persisted match flags and `match_reason`; source `details` are not guaranteed. The reviewer UI must render the flags and stored reason directly instead of relying on an optional details object.

**Why:** A valid candidate otherwise appears as only a transaction type, ID, and score, leaving the reviewer unable to tell why it was suggested or why it needs manual review.

**How to apply:** Keep amount, date, name, reference, and proof signals visible in the candidate card; use source details as additional expandable evidence, not as the only explanation.