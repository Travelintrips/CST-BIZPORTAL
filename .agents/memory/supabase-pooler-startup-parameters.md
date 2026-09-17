---
name: Supabase pooler startup parameters
description: Compatibility constraint for node-postgres connections to Supabase pooler endpoints.
---

Do not configure PostgreSQL `statement_timeout` as a node-postgres Pool startup option when the connection may use a Supabase transaction pooler. Use a client-side query timeout or an explicit per-query/session-safe mechanism instead.

**Why:** Supabase's pooler rejects `statement_timeout` during startup, preventing every database connection and cascading into 500/503 responses across unrelated API endpoints.

**How to apply:** When production uses `SUPABASE_DATABASE_URL`, keep pool startup options limited to supported connection settings and verify `/api/health/ready` after publishing.