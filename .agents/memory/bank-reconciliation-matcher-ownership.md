---
name: Bank reconciliation matcher ownership
description: Boundary between the local BizPortal proxy/UI and the upstream bank reconciliation matcher.
---

The standalone BizPortal API now owns a deliberately limited matcher for canonical Sport Center payments and posted vendor invoices; broader rule/ECF matching and server-side auto-post decisions remain upstream-only. The local matcher must never auto-post.

**Why:** The standalone UI called a missing matching endpoint after the upstream API was removed. A local endpoint is needed for basic reconciliation, but recreating the full upstream decision stack locally would risk inconsistent accounting behavior.

**How to apply:** Keep local matching scoped to canonical candidate tables, exact amount/date/reference signals, candidate/audit persistence, and review/approval states. Add new rule sources only with explicit schema and accounting safeguards; do not silently fall back to frontend data or auto-post.