---
name: Imported PPh liability accounts
description: Trust boundary and validation rule for liability accounts carried in imported vendor-invoice tax data.
---

Do not mark imported PPh rows confirmed from a liability account ID embedded in invoice breakdown data. Create the tax rows in tax-review state, then require Finance Review to select and validate each liability account in the active company.

**Why:** Imported identifiers are client-controlled and may refer to a missing, inactive, non-postable, non-liability, or cross-company account. Trusting them can misstate the payment journal or violate tenant isolation.

**How to apply:** For every PPh type and tax object, validate the selected account as active, postable, liability-type, and owned by the active company before confirming the tax row or allowing net bank reconciliation.