---
name: Deployment duplicate-comment failures
description: Merge artifacts can leave duplicate modules inside an unterminated block comment, causing publish-time esbuild EOF errors.
---

Treat an esbuild error such as “Expected */ to terminate multi-line comment” near end-of-file as a possible merge artifact, not only a local typo. Check whether a duplicate module was appended after an unfinished `/*`; validate the active production artifact builds separately from repository-wide typecheck, because test files can contain the same latent issue.

**Why:** A merged workspace can publish successfully in earlier revisions while a later merge leaves duplicate source blocks that the deployment builder parses even though local workflows do not exercise them.

**How to apply:** Inspect the reported file for duplicate module headers and unmatched comment delimiters, preserve the first canonical implementation, close or remove stale duplicate blocks, then run the exact artifact production build commands and the broader typecheck.