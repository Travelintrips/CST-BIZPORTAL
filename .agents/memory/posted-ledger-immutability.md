---
name: Posted ledger immutability
description: Production accounting entries protect posted financial fields from direct edits.
---

Posted accounting entries must not be corrected by directly updating financial fields such as the date. Use the application's reversal and replacement-entry workflow instead.

**Why:** Production enforces this with a database immutability trigger, and bypassing it would break the audit trail and leave related payment records inconsistent.

**How to apply:** For a posted payment date correction, preserve the original entry, create the required reversal/correction entry through the accounting workflow, and only then adjust matching evidence if needed.