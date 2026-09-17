---
name: Sport Center draft idempotency
description: Payment accounting draft idempotency spans canonical reversal validation and a draft-only unique index.
---

The Sport Center payment draft function is stored in the external PostgreSQL database rather than the repository's Drizzle schema. Its migration source must preserve the existing tax, COA, and QRIS-clearing body while replacing only the idempotency guard. A payment_confirmed journal is reusable only when it has no reversal; any linked reversal must be exactly one posted, balanced, line-count-equal, total-equal, exact debit/credit opposite, otherwise the function fails closed. Once a valid reversal exists, historical public projections must not block the replacement draft.

**Why:** The old unique payment index could not express “unless the journal has a valid reversal,” so a correctly reversed historical posting still blocked the current payment draft.

**How to apply:** Keep the per-payment advisory lock, use a unique index for active payment_confirmed drafts only, and apply the SQL source to development first. Production is a separate external database and must be updated through the controlled production migration path.