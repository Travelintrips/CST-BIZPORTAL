---
name: Merge-block cleanup
description: Durable guidance for reconciling duplicated source blocks left by incomplete merges.
---

When a duplicated merge block is being disabled or removed, compare its route and test contracts with the canonical block first. A later block may contain a legitimate endpoint or assertion that the earlier block does not have.

**Why:** A publish fix that only comments out the duplicate can make the build pass while silently removing a required route; one such detail endpoint was present only in the later block.

**How to apply:** Search both blocks for route paths, exported functions, and contract-test expectations. Move any missing canonical behavior into the active block before deleting or permanently removing stale duplicate code.