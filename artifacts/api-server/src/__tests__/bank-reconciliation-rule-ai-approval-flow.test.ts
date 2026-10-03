import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)),
  "utf8",
);

describe("Rule AI manual approval flow", () => {
  it("hydrates Rule AI approval metadata for the BizPortal queue", () => {
    expect(source).toContain('const ruleIds = idsFor("recon_rule")');
    expect(source).toContain("candidateRequirement: row.candidate_requirement");
    expect(source).toContain("targetCoaValidationStatus:");
  });

  it("uses the Rule AI target COA and blocks COA drift", () => {
    expect(source).toContain('selectedCandidateType === "recon_rule"');
    expect(source).toContain('rule.candidate_requirement !== "not_required"');
    expect(source).toContain("manualCoaCode = ruleCoaCode");
    expect(source).toContain('"RULE_COA_MISMATCH"');
  });

  it("exposes server-authoritative approval readiness for no-candidate Rule AI matches", () => {
    expect(source).toContain("as approval_ready");
    expect(source).toContain("rule.candidate_requirement = 'not_required'");
    expect(source).toContain("target_coa.is_postable");
    expect(source).toContain('20261003-rule-ready-v3');
  });
});
