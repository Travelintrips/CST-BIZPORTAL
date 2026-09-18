---
name: Top-level artifact routing
description: Replit preview gateway behavior for artifact manifests stored in nested upstream workspaces.
---

The preview gateway only maps artifact services whose manifests are registered from the workspace's top-level `artifacts/` directory. A valid artifact manifest under a nested upstream workspace can appear in artifact metadata while still being absent from the active root router.

**Why:** A Customer Portal manifest under `.upstream-cst-super-app/artifacts/` was registered but the preview gateway exposed only `/bizportal`; the root URL returned 404 until a validated top-level wrapper manifest was registered.

**How to apply:** Keep the application source in the upstream workspace, but place a validated manifest under `artifacts/<slug>/.replit-artifact/artifact.toml`. Point its development command and production build/public paths back to the upstream source, and avoid running both nested and wrapper services on the same port.