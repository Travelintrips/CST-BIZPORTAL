import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(process.cwd(), "src/pages/accounting/bank-reconciliation.tsx"),
  "utf8",
);

describe("Rule AI ready-approval visibility", () => {
  it("treats no-candidate Rule AI matches as reviewable without a date match", () => {
    expect(source).toContain('candidate.candidate_type === "recon_rule"');
    expect(source).toContain('m.review_code === "RULE_AI_MATCH"');
    expect(source).toContain('candidate.details?.candidateRequirement === "not_required"');
    expect(source).toContain('candidate.details?.targetCoaValidationStatus === "valid"');
  });

  it("uses server approval_ready as the authoritative Rule AI queue signal", () => {
    expect(source).toContain("approval_ready?: boolean | null");
    expect(source).toContain('m.approval_ready === true');
  });
});
