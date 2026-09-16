---
name: Production verification prerequisites
description: Replit deployment and database prerequisites for live read-only verification.
---

Replit's production database replica and published URL are not available until the app has an active deployment. A development database being reachable does not imply that production data can be queried.

**Why:** The production SQL surface returns a no-production-database error for undeployed projects, and deployment metadata has no URL to test. This blocks live invoice/API verification even when local code and development data are healthy.

**How to apply:** Check deployment metadata before planning production checks. If no deployment exists, do not mutate data or claim live verification; validate locally and defer the read-only production check until the user publishes the app and supplies the required authenticated access path.