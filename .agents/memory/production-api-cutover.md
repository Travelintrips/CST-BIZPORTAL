---
name: Production API cutover
description: The production BizPortal API must run the complete upstream server instead of the partial self-proxy.
---

Production API publishing must use the complete upstream BizPortal server for route handling. A database readiness response alone does not prove menu APIs are correctly routed: the partial proxy can report Supabase connected while forwarding business routes back to the public BizPortal origin and producing 502/429 storms.

**Why:** The public BizPortal domain was configured as its own upstream origin, so health checks passed but accounting and other menu requests self-looped until timeout or rate limiting.

**How to apply:** Before declaring a production cutover healthy, verify both database readiness and an authenticated representative business route, and confirm deployment logs do not show the public BizPortal domain as its own upstream.