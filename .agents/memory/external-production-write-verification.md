---
name: External production write verification
description: Verification rule for destructive writes against the external production database.
---

When a direct production database write times out after candidate selection, do not retry immediately. First verify the post-write state against the captured candidate set; the client or shell can time out after the database has committed.

**Why:** External Supabase writes may outlive the local command timeout, so an automatic retry can delete or mutate a second, unintended set.

**How to apply:** Capture a minimal candidate backup before the transaction, use a strict count guard, and compare remaining rows and dependent records before declaring success or attempting another write.