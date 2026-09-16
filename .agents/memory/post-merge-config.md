---
name: Post-merge configuration integrity
description: Replit merge recovery can corrupt .replit sections or duplicate environment keys.
---

The `.replit` file must retain one valid `[postMerge]` section with a configured script path and must not contain duplicate keys in any `userenv` table.

**Why:** A merge conflict in `.replit` can make the post-merge hook appear missing and prevents workflow reconciliation from parsing the project configuration.

**How to apply:** Treat `.replit` as schema-validated configuration after merges, preserve environment-specific API origins, and keep browser API routing same-origin rather than restoring ephemeral hosts.