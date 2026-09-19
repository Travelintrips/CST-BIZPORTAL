---
name: Accounting journal detail endpoint
description: The bank reconciliation posting dialog needs a company-scoped journal detail API, not only the collection endpoint.
---

The posting confirmation dialog fetches the canonical journal header and lines by entry ID before allowing promotion from draft to posted. The detail route must enforce the same company scope as the accounting session and read directly from the canonical accounting entry tables.

**Why:** A mutation can contain a valid draft `journal_entry_id` while the collection endpoint still works; without the `/:id` detail route, the dialog shows a generic “Gagal memuat journal entry” and blocks safe posting.

**How to apply:** Keep the detail route registered before the collection route, validate the positive entry ID and company scope, return header totals/status plus ordered journal lines, and keep the UI’s posting button disabled until that response is loaded.