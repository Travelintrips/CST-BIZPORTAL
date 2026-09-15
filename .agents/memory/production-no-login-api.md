---
name: Production no-login API access
description: Constraint for keeping BizPortal production usable with a shared admin identity and no login screen.
---

If production remains configured without login, every API used by the frontend must support that mode explicitly. Removing only the frontend login does not create an authenticated upstream backend session.

**Why:** The production UI rendered as a shared admin, but proxied endpoints still returned 401/403. This caused data-backed controls such as the company selector to appear empty even though Supabase contained records.

**How to apply:** For new or existing production flows, verify the actual API request without a browser login. Provide a production-only shared identity mechanism or a narrowly scoped local endpoint, and never forward development identity headers to the production upstream.