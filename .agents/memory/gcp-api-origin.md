---
name: GCP API origin separation
description: Development Secret Manager configuration and the backend URL required by the BizPortal proxy.
---

The development Secret Manager payload currently provides a frontend URL instead of a separate backend API origin. The proxy must use explicit environment-specific origins (`BIZPORTAL_API_ORIGIN_DEV` and `BIZPORTAL_API_ORIGIN_PROD`) and must not silently fall back to production.

**Why:** Requests sent to the frontend URL return 404 for BizPortal API routes, while forwarding development identity to the production host is intentionally blocked.

**How to apply:** Keep `BIZPORTAL_API_ORIGIN_PROD` pointed at the production API and configure `BIZPORTAL_API_ORIGIN_DEV` only with a separate development API origin. If the development origin is missing, fail clearly instead of using production.

Development accounting queries also require `SUPABASE_DATABASE_URL_DEV` as a valid PostgreSQL connection string; `SUPABASE_URL_DEV` is a frontend Supabase URL and cannot replace the database connection.

**Why:** The Accounting Hub reads reporting tables directly through the server-side pool, so an API URL or malformed connection string produces a 503 even when the frontend and API health checks are working.

**How to apply:** Keep the frontend Supabase URL and environment-specific PostgreSQL connection separate, and validate the database connection after changing either secret.

Development module access also requires an upstream `sid` session in addition to the local development session. The development login bridge should namespace that upstream cookie before returning it to the browser.

**Why:** The development backend accepts its own `/api/auth/dev-login` session cookie for notifications, drivers, and related modules; a local-only session otherwise leaves those routes at 401 even when the API origin is correct.

**How to apply:** Keep the local cookie for Replit-owned accounting/auth routes and forward only the namespaced upstream cookie through the development proxy. Do not apply this bridge to production.