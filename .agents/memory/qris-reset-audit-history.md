---
name: QRIS reset audit history
description: Source and payload rules for displaying QRIS settlement reset history.
---

QRIS reset history must be read from the server audit-log contract, not browser state. Reset requests should include the settlement date alongside the controlled automatic reason so audit rows can be grouped by reconciliation date even when one bulk action calls the upstream endpoint once per payment.

**Why:** The QRIS settlement mutation is owned by the upstream service while this workspace owns the UI. Browser-only history disappears on refresh and cannot provide an auditable operator trail.

**How to apply:** Keep reset execution sequential and fail-closed for active/posted/reconciled batch membership. Parse and group the upstream audit rows by settlement date, and show server errors explicitly instead of treating them as an empty history.