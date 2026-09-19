---
name: Local tenant candidate contract
description: Canonical source and identity rules for tenant payment candidates in local bank reconciliation.
---

Local tenant reconciliation candidates represent confirmed or paid rows from `public.tenant_payments`; the candidate ID is `tenant_payments.id`, not a tenant invoice or booking ID. Candidate details should be hydrated from the same canonical source before UI classification or approval.

**Why:** Tenant payment matching and approval need one stable ownership boundary. Reusing invoice or booking identities can approve the wrong record or make the UI unable to classify the payment.

**How to apply:** Keep tenant matching fail-soft when the optional tenant schema is absent, validate company ownership and active payment status at approval, and preserve `candidate_source = public.tenant_payments`.