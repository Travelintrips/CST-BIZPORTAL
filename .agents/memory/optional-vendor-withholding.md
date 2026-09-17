---
name: Optional vendor withholding
description: Domain invariant for vendor invoice detail reads when PPh is disabled.
---

An invoice with `withholding_tax_amount = 0` and no `vendor_withholding_records` is a valid state. Detail reads and refreshes must return that state unchanged, and PPh liability accounts should only be requested when a positive withholding amount is present.

**Why:** PPh is optional and is applied at payment time; treating an empty withholding state as incomplete caused a secondary liability-account request to break otherwise valid invoice pages.

**How to apply:** Keep GET/detail paths read-only. Derive whether PPh is active from the canonical positive withholding amount or positive line tax values before loading liability-account data. Never regenerate withholding records from legacy line-tax identifiers during reads.