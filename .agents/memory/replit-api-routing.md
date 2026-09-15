---
name: Replit artifact API routing
description: Canonical development and production API routing for this workspace
---

Replit artifact services use same-origin, path-based routing: the web artifact calls `/api`, while the current `REPLIT_DEV_DOMAIN` is ephemeral and must not be pinned in project configuration.

**Why:** A previously pinned development domain became stale and returned `502`; the current runtime domain served both the web artifact and `/api` successfully.

**How to apply:** Keep frontend API calls relative to the artifact origin. Treat `BIZPORTAL_API_ORIGIN` as the API server's external upstream target, not as the URL of its own Replit workflow.