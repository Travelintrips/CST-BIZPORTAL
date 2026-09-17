---
name: PPh reset scope
description: Canonical cleanup scope for removing vendor-invoice withholding before re-reconciliation.
---

Vendor-invoice PPh can be represented in the invoice amount/type fields, invoice-breakdown JSON, line-tax rows, and withholding-record rows. A reset must clear all applicable representations while preserving gross totals, VAT, journal entries, and payment allocations.

**Why:** Clearing only withholding records leaves denormalized breakdown values that can make PPh reappear in invoice and reconciliation screens.

**How to apply:** Identify invoices by company-scoped IDs, verify dependent rows first, then use one transaction to remove PPh detail rows and reset the invoice’s withholding representations.