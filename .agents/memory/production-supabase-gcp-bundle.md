---
name: Production Supabase GCP bundle
description: Production Supabase credentials are sourced from the GCP production secret bundle.
---

For this imported CST app, the Replit environment's SUPABASE_DATABASE_URL may be stale or unusable for production reads. The canonical production database URL is loaded from the GCP Secret Manager production bundle using the configured bootstrap credential.

**Why:** Direct authentication with the configured Replit production URL failed while the GCP-loaded production bundle connected and exposed the live reconciliation data.

**How to apply:** For read-only production diagnostics, use the project's production secret-loader path or equivalent GCP bundle access; never print or persist the secret values, and never substitute the development URL.