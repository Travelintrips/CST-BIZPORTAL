---
name: Top-level artifact routing
description: CST-BIZPORTAL standalone artifact routing and source-of-truth boundary.
---

The active application source of truth is the repository's top-level `artifacts/` workspace. Production build, development runtime, tests, and preview routing must resolve only to those root artifacts.

**Why:** CST-BIZPORTAL has been separated from CST-SUPER-APP. The `.upstream-cst-super-app/` tree is retained only as historical/reference material and must never be used as an application source, build target, runtime target, or deployment dependency.

**How to apply:** Keep each active manifest under `artifacts/<slug>/.replit-artifact/` and point development/build/run commands to the matching top-level artifact. Never point manifests, scripts, CI, or production commands into `.upstream-cst-super-app/`. If historical code is needed for comparison, read it only as reference and port the required behavior into the standalone root artifact.
