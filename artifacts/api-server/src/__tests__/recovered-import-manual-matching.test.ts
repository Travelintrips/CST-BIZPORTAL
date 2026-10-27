import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const code = readFileSync(
  resolve(process.cwd(), "src/routes/bank-reconciliation.ts"), "utf8",
);

describe("recovered bank import matching cannot auto-post or auto-approve", () => {
  it("detects recovered imported mutations separately from standard banking", () => {
    expect(code).toContain('mutation.review_code === "SOURCE_RECOVERY_MANUAL_REVIEW"');
  });

  it("keeps recovered mutation in manual review even with a confident Rule AI match", () => {
    expect(code).toContain('if (requiresRecoveredSourceReview) {');
    expect(code).toContain("review_code='SOURCE_RECOVERY_MANUAL_REVIEW'");
    expect(code).toContain('source_recovery_manual_review: true');
    expect(code).toContain('auto_approval_allowed: false');
    expect(code).toContain('return "manual_review"');
  });

  it("never allows a recovered mutation to auto-post from a future rule", () => {
    expect(code).toContain("const autoPostEligible = !requiresRecoveredSourceReview");
    expect(code).toContain("&& isReconRuleAutoApprovalAllowed(matchedRule.id)");
  });

  it("preserves the recovery audit marker when no canonical candidate exists", () => {
    expect(code).toContain("review_code=case when review_code='SOURCE_RECOVERY_MANUAL_REVIEW'");
    expect(code).toContain("else 'RULE_NO_CANONICAL_CANDIDATE'");
    expect(code).toContain("else 'RULE_MULTIPLE_CANONICAL_CANDIDATES'");
  });

  it("treats suggested local candidates as manual review, not as posted payments", () => {
    expect(code).toContain("requiresRecoveredSourceReview || isAmbiguous");
    expect(code).toContain('requiresRecoveredSourceReview\n        ? "SOURCE_RECOVERY_MANUAL_REVIEW"');
    expect(code).toContain("status not in ('approved_pending_posting', 'approved', 'posted', 'void')");
  });
});
