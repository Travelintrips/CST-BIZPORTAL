import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/routes/bank-reconciliation.ts"), "utf8");

describe("reconciliation matching for safely reversed auto-posted Rule AI entries", () => {
  it("includes reopened mutations in the normal matching mode despite historical MATCH_CREATED audit", () => {
    expect(source).toContain("bm.review_code = 'RECON_REVERSAL_REVIEW'");
    expect(source).toContain("bm.status = 'unmatched'");
    expect(source).toContain("final_match.status in ('approved', 'posted')");
    expect(source).toContain("audit.action = 'MATCH_CREATED'");
    expect(source).toContain("bm.status in ('unmatched', 'matched', 'duplicate_need_review')");
  });
  it("keeps posted mutation and approved candidate exclusions in rematch modes", () => {
    expect(source).toContain("bm.status in ('unmatched', 'matched', 'manual_review', 'duplicate_need_review')");
    expect(source).toContain("final_match.status in ('approved', 'posted')");
  });
});
