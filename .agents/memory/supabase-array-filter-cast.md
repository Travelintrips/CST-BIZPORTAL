---
name: Supabase array filter casts
description: PostgreSQL parameter-cast behavior for array-backed filters through the Supabase pooler.
---

For small fixed sets of trusted enum values, use a SQL literal list such as `status in ('posted', 'approved')` instead of binding a JavaScript array through `any($n::text[])`.

**Why:** The Supabase-backed runtime returned PostgreSQL 42846 for the parameterized text-array cast, causing a valid reconciliation filter to surface as a misleading 503 schema error.

**How to apply:** Prefer validated scalar parameters for dynamic filters. For a fixed enum alias, keep the allowed values in source and emit the literal list; do not interpolate user input.