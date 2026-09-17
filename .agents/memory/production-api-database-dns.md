---
name: Production API database DNS
description: Diagnostic rule for a published API whose frontend loads but database-backed pages remain pending.
---

The published static frontend can remain reachable while the API is degraded because its production database hostname cannot be resolved. Treat `/api/health/ready` returning `503` with a DNS error as the primary cause of slow or stuck database-backed pages, not as a frontend rendering problem.

**Why:** The production deployment served the BizPortal shell successfully while the API readiness check reported `getaddrinfo EAI_AGAIN` for its configured database host; development remained healthy.

**How to apply:** Check the published API readiness endpoint before optimizing a page query. Correct the production database URL/secret and redeploy or restart the API; do not replace the same-origin API path or hide the failure with an indefinite loading state.