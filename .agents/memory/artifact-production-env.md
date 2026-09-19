---
name: Artifact production environment injection
description: Root userenv values may not reach a monorepo artifact process in deployment.
---

Production-only values required by an artifact service must be declared in that service's `artifact.toml` runtime environment, not only in the root `.replit` userenv block.

**Why:** The deployed API process started successfully but could not see the configured upstream origin, so authentication requests failed with a configuration 503 even though the production environment variable existed at the workspace level.

**How to apply:** For each artifact process, declare its non-secret runtime configuration under the matching `[services.production.run.env]` block and republish after changing it. Keep secrets in Replit Secrets.

The root recursive workspace build does not inherit an artifact's `services.env` block. Build-time Vite configuration must therefore provide safe artifact-local defaults (or receive explicit build env) instead of requiring runtime-only variables.

**Why:** A publish validation build can execute every workspace package without the artifact runtime environment, so a design preview package that requires `PORT` or `BASE_PATH` at config-load time can fail before the selected service is built.

**How to apply:** Keep runtime env declarations for deployed processes, and make package build configuration deterministic without relying on those runtime declarations.