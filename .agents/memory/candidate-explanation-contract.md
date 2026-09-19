---
name: Bank reconciliation candidate explanation
description: Candidate cards must explain matching evidence even when source details are absent.
---

The bank reconciliation candidate list can contain only persisted match flags and `match_reason`; source `details` are not guaranteed. The reviewer UI must render the flags and stored reason directly instead of relying on an optional details object.

**Why:** A valid candidate otherwise appears as only a transaction type, ID, and score, leaving the reviewer unable to tell why it was suggested or why it needs manual review.

**How to apply:** Keep amount, date, name, reference, and proof signals visible in the candidate card; use source details as additional expandable evidence, not as the only explanation.

Repair diagnosis is also a read-only canonical contract: the detail panel must read `/:mutationId/repair-diagnosis`, and any retry must call `run-matching` with that mutation ID and `rematch_non_final`.

**Why:** The standalone legacy repair endpoint intentionally fails closed; calling it from the detail panel produces a misleading production error and can encourage unsafe repair workarounds.

**How to apply:** Keep stale-client protection on the server, but remove legacy repair controls from the UI and scope all re-evaluation to the selected non-final mutation.