---
name: GitHub push fallback
description: Use the bound GitHub connector's Git Data API when shell HTTPS credentials are unavailable or rejected.
---

When the repository remote rejects shell credentials, an authorized GitHub connector can publish the same committed tree by creating blobs, a tree, a commit, and advancing the branch ref with `force: false`.

**Why:** The workspace may have a valid Replit GitHub connection while `git push` has no usable credential helper or an invalid token.

**How to apply:** Resolve and bind the GitHub connection first, use its authenticated proxy for the Git Data API, base the tree on the current remote branch ref, and verify the resulting remote commit SHA independently.