---
name: Vendor invoice payment settlement
description: Canonical source and schema compatibility rules for AP payment projection.
---

The AP payment projection must sum active `payment_allocations` rows only when their Bank Reconciliation settlement is final/posted (or the existing reconciled equivalent). The allocation amount is the payment amount; `vendor_invoices.amount_paid` is legacy and must not drive Terbayar.

**Why:** The affected invoices had legacy paid values even though no canonical Bank Reconciliation payment existed. The upstream allocation relationship has appeared as either `vendor_invoice_id` or `invoice_id`, so a source-only projection must tolerate both without changing the database.

**How to apply:** Keep a dedicated backend reconciliation amount field in list and detail responses, and make the frontend use that field only. Do not infer payment from grand total, payable amount, invoice status, or invoice breakdown tax snapshots.