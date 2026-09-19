---
name: Bank reconciliation matcher ownership
description: Boundary between the local BizPortal proxy/UI and the upstream bank reconciliation matcher.
---

The standalone BizPortal API owns a deliberately limited matcher for canonical Sport Center payments and posted vendor invoices. It may also auto-approve and auto-post an explicit deterministic Rule AI match, but only when the rule has 100% confidence, a valid target COA, no ambiguity, no required candidate/document, and the transaction passes the normal approval safeguards. Broader rule/ECF matching remains upstream-only.

**Why:** The standalone UI called a missing matching endpoint after the upstream API was removed. A local endpoint is needed for basic reconciliation, but recreating the full upstream decision stack locally would risk inconsistent accounting behavior. The explicit deterministic Rule AI exception is needed for routine bank allocations that have a configured COA and do not depend on a source transaction.

**How to apply:** Keep local matching scoped to canonical candidate tables, exact amount/date/reference signals, candidate/audit persistence, and review/approval states. Treat auto-post as an allowlist for deterministic Rule AI only; never extend it to broad fuzzy matches, ambiguous rules, required-candidate rules, or missing COA/document mappings.

QRIS candidate generation and AI matching do not create canonical Sport Center
settlement batches. QRIS approval is the ownership boundary: it must idempotently
build or reuse the complete canonical batch through the owner database routines,
then verify the posted settlement journal, item scope, and settled payment state
before linking the bank mutation.

**Why:** A production candidate could match repeatedly while approval stayed
blocked because the local matcher only persisted a review snapshot and the
approval path required a canonical batch that nothing local created.

**How to apply:** Do not make `/run-matching` or QRIS candidate generation write
`sport_center` settlement rows. Keep approval fail-closed for missing owner
configuration, posted payment journals, canonical COA mapping, or incomplete
post-finalization verification.