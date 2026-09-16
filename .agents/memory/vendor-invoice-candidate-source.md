---
name: Vendor invoice candidate source
description: Source-of-truth rules for Match / Link Invoice Vendor candidates in bank reconciliation.
---

The candidate list must derive payment progress from active `payment_allocations` joined to `payment_matching_groups` with final `posted` or `reconciled` status and a real bank mutation link. Do not exclude invoices using stale `vendor_invoices.amount_paid`, historical settlement labels, or old `finance_payment_events` when canonical reconciliation evidence is absent.

**Why:** Legacy proxy filtering hid posted vendor invoices that had no current canonical reconciliation evidence, including valid partial-payment candidates.

**How to apply:** Require posted invoice status, company scope, active supplier, and canonical remaining balance greater than zero. The frontend should trust the endpoint's outstanding amount and must not independently discard `settled_unlinked` records.