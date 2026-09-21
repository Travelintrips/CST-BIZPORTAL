---
name: Merge-block cleanup
description: Durable guidance for reconciling duplicated source blocks left by incomplete merges.
---

When a duplicated merge block is being disabled or removed, compare its route and test contracts with the canonical block first. A later block may contain a legitimate endpoint or assertion that the earlier block does not have.

**Why:** A publish fix that only comments out the duplicate can make the build pass while silently removing a required route; one such detail endpoint was present only in the later block.

**How to apply:** Search both blocks for route paths, exported functions, and contract-test expectations. Move any missing canonical behavior into the active block before deleting or permanently removing stale duplicate code.

Commenting a duplicate block is only a temporary compiler fix: raw-source integrity checks can still count declarations and tests inside comments.

**Why:** The publish tree had concatenated implementations, and source-contract tests counted the inactive copies even after the TypeScript compiler ignored them.

**How to apply:** Preserve the first canonical implementation only after comparing contracts; if comments are used as a short-lived safety boundary, make integrity checks comment-aware and schedule permanent removal of the stale text.

After resolving one merged file, validate every related file named in the task for orphaned comment delimiters before declaring the rebase complete.

**Why:** A rebase can restore a sibling source file with a stray closing delimiter even when the visible conflict is limited to the test file; repository-wide validation catches this only after the merge.

**How to apply:** Run the full typecheck and production builds after conflict resolution, and inspect comment delimiters in the task's related source files when the failure involves merged blocks.