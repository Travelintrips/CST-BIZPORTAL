---
name: GCP API origin separation
description: Development Secret Manager configuration and the backend URL required by the BizPortal proxy.
---

The development Secret Manager payload currently provides a frontend URL instead of a separate backend API origin. The proxy must use explicit environment-specific origins (`BIZPORTAL_API_ORIGIN_DEV` and `BIZPORTAL_API_ORIGIN_PROD`) and must not silently fall back to production. Production auth must not proxy to the published BizPortal domain itself.

**Why:** Requests sent to the frontend URL return 404 for BizPortal API routes, while forwarding development identity to the production host is intentionally blocked.

**How to apply:** Treat `bizportal.cstlogistic.co.id` as the current published BizPortal deployment, not as an upstream origin. Keep auth local or configure a genuinely separate BizPortal backend origin; reject ephemeral `*.replit.dev` hosts and fail clearly if the development origin is missing instead of using production.

Development accounting queries also require `SUPABASE_DATABASE_URL_DEV` as a valid PostgreSQL connection string; `SUPABASE_URL_DEV` is a frontend Supabase URL and cannot replace the database connection.

**Why:** The Accounting Hub reads reporting tables directly through the server-side pool, so an API URL or malformed connection string produces a 503 even when the frontend and API health checks are working.

**How to apply:** Keep the frontend Supabase URL and environment-specific PostgreSQL connection separate, and validate the database connection after changing either secret.

Development module access also requires an upstream `sid` session in addition to the local development session. The development login bridge should namespace that upstream cookie before returning it to the browser.

**Why:** The development backend accepts its own `/api/auth/dev-login` session cookie for notifications, drivers, and related modules; a local-only session otherwise leaves those routes at 401 even when the API origin is correct.

**How to apply:** Keep the local cookie for Replit-owned accounting/auth routes and forward only the namespaced upstream cookie through the development proxy. Do not apply this bridge to production.

The stable `bizportal.cstlogistic.co.id` host currently serves the API health endpoint but returns 404 for `/api/auth/dev-login`; do not assume the stable host supports the upstream development-login bridge.

**Why:** Host migration can remove the temporary backend's development-only login route while leaving health and regular API routing available.

**How to apply:** Verify the upstream authentication contract separately before treating a host migration as a complete login migration.

When the optional development upstream login bridge returns 404 or 5xx, local Dev Login may still issue its separately signed development session so API-owned Finance and Accounting routes remain usable. Keep 401/403 and origin-configuration failures blocking; proxied routes must continue using signed development identity headers.

**Why:** The development database-backed Finance and Accounting endpoints are owned by this API, while the temporary upstream can be unavailable during host migration. Treating that outage as a local-auth bypass would be unsafe.

**How to apply:** Preserve the allowlisted-email and session-secret checks, namespace upstream cookies when the bridge succeeds, and never enable this behavior in production.