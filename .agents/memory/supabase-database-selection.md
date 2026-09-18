---
name: Supabase database selection
description: Runtime database selection must fail closed instead of falling back to Replit's generic DATABASE_URL.
---

Runtime database resolution must use the environment-specific Supabase URL or the approved Secret Manager fallback; a generic `DATABASE_URL` is never a valid application fallback.

**Why:** The API can report healthy while silently connecting to the workspace database if `DATABASE_URL` wins before the Supabase secret is resolved.

**How to apply:** Keep runtime selection limited to `SUPABASE_DATABASE_URL_DEV`, `SUPABASE_DATABASE_URL`, or an explicitly Supabase-specific URL, and make readiness report the actually resolved runtime provider.