#!/bin/bash
set -euo pipefail

# Merges must not introspect or mutate an external Supabase schema by default.
# Database migrations, when present, should be applied by their dedicated,
# explicit migration command instead of an interactive drizzle-kit push.
pnpm install --frozen-lockfile --prefer-offline
