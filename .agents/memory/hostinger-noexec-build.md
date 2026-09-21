---
name: Hostinger noexec bootstrap
description: Constraints for running the workspace build on Hostinger when /tmp cannot execute files.
---

The Hostinger build must install pnpm into a workspace or home-cache directory, put a wrapper for that exact pnpm version first on `PATH`, and route temporary/cache paths there. Remove inherited esbuild path overrides before starting install or build, and keep a second workspace/home location as fallback.

**Why:** Hostinger can expose `/tmp` as `noexec`, while recursive workspace scripts may invoke `pnpm` again and an inherited `ESBUILD_BINARY_PATH` can point directly into `/tmp`. A one-time bootstrap of the top-level command is not enough if child scripts resolve another pnpm executable.

**How to apply:** Keep the project build entrypoint as a Node bootstrap script. Use the runtime's `process.execPath` for the installed pnpm entrypoint and its `PATH` wrapper, use only workspace/home locations for tool/temp/cache files, and verify the complete workspace build rather than only the frontend bundle.