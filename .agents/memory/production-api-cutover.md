---
name: Production API cutover
description: Production BizPortal must run the local API source with no upstream fallback; publish only after required route parity is complete.
---

Production API publishing must use the local BizPortal API source and must not fall back to CST-SUPER-APP. A database readiness response alone does not prove menu APIs are available: routes without local implementations fail explicitly and must be completed before publishing.

**Why:** The public BizPortal domain was configured as its own upstream origin, so health checks passed while accounting and other menu requests self-looped; the current product constraint also forbids using CST-SUPER-APP.

**How to apply:** Before declaring a production cutover healthy, verify database readiness, local auth, representative local business routes, and deployment logs with no upstream-origin calls. Do not publish while required business parity is incomplete.