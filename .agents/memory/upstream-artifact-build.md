---
name: Upstream artifact build dependencies
description: Production builds that point at an upstream workspace must install that workspace before running its package script.
---

When an artifact's production build targets a package under a nested upstream workspace, the build command must install that workspace with its lockfile before invoking the package build.

**Why:** Publishing installs the root workspace only; nested packages can otherwise reach their script with no local `node_modules`, causing missing-tool errors even when the source build works locally.

**How to apply:** Keep the nested workspace install and build in the artifact's production build command, and verify the exact command from a clean dependency state.