---
name: Production verification prerequisites
description: Replit deployment and database prerequisites for live read-only verification.
---

Replit's production database replica and published URL become available only after the app has an active deployment. A development database being reachable does not imply that production data can be queried.

**Why:** The production SQL surface returns a no-production-database error for undeployed projects, and deployment metadata has no URL to test. This blocks live invoice/API verification even when local code and development data are healthy.

**How to apply:** Check deployment metadata before planning production checks. After a successful publish, verify the live API health/readiness endpoint and use the production database surface only for read-only checks when needed.