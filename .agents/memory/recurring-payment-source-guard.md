---
name: Recurring payment source guard
description: Non-obvious status and concurrency constraints for canonical recurring Sport Center payments.
---

The canonical Sport Center payment enum is narrower than the public mirror: its active states are pending, confirmed, and waiting_confirmation; rejected is the supported inactive state for audited replacement. Database uniqueness must use the canonical enum, not mirror-only values such as cancelled or expired.

**Why:** A partial index predicate that named mirror statuses failed against the canonical enum. A recurring-series guard must remain valid in the external sport_center schema while preserving posted journals.

**How to apply:** Enforce one active recurring_series_id with both a partial unique index and a per-series transaction advisory lock. Void/reverse the old payment and set it to rejected before creating its replacement.