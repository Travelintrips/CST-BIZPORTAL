---
name: Bank reconciliation matcher ownership
description: Boundary between the local BizPortal proxy/UI and the upstream bank reconciliation matcher.
---

Candidate generation and server-side auto-post decisions for bank reconciliation are owned by the configured upstream service. The local BizPortal workspace can control candidate visibility, reviewer selection, and UI safeguards, but it cannot create a missing candidate when the upstream response contains `candidate_count = 0`.

**Why:** Production mutation records can have matching payment evidence while the upstream matcher returns no candidate; adding frontend fallback data would create an unapproved or non-persisted accounting source.

**How to apply:** Change the upstream matcher for date/amount candidate creation and name-gated auto-post behavior. Keep local changes limited to rendering, selection, approval request contracts, and explicit safeguards unless the upstream matcher source is mounted in the workspace.