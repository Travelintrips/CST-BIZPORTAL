---
name: GCP API origin separation
description: Development Secret Manager configuration and the backend URL required by the BizPortal proxy.
---

The development Secret Manager payload currently provides a frontend URL under `BIZPORTAL_API_ORIGIN`; it does not provide a separate backend API origin. The proxy must not use that frontend URL or silently fall back to production.

**Why:** Requests sent to the frontend URL return 404 for BizPortal API routes, while forwarding development identity to the production host is intentionally blocked.

**How to apply:** Before enabling development API-backed modules, configure a backend API origin in the development secret (prefer a backend-specific field) or deploy/identify the development API service. Keep production and development origins separate.