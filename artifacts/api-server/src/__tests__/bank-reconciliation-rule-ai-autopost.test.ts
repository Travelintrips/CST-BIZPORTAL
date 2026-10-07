import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const route = readFileSync(fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)), "utf8");

describe("Rule AI deterministic auto posting", () => {
  it("auto posts deterministic rules and approved Kas Besar SC rules with COA", () => {
    expect(route).toContain("confidence === 100 || kasScApprovedRuleAutoPost");
    expect(route).toContain("confidence >= 80");
    expect(route).toContain("isKasBesarScReconciliationAccount");
    expect(route).toContain("upper(trim(coalesce(coa.code, ''))) = '1-1010-CST'");
    expect(route).toContain("matchedRule.candidateRequirement !== 'required'");
    expect(route).toContain("Boolean(matchedRule.targetCoaCode)");
    expect(route).toContain("!ruleResult.ambiguityCode");
    expect(route).toContain('!(mutation.direction === "IN" && hasQrisBankEvidenceForAutoPost(mutation))');
  });

  it("allows deterministic outbound QRIS while keeping inbound QRIS settlement-owned", () => {
    expect(route).toContain('mutation.direction === "IN"');
    expect(route).toContain("hasQrisBankEvidenceForAutoPost(mutation)");
    expect(route).toContain("Outbound QRIS is an ordinary company payment rail");
  });

  it("uses rule target COA and canonical source", () => {
    expect(route).toContain("candidate_source: 'public.recon_rules'");
    expect(route).toContain("manual_coa_code: matchedRule.targetCoaCode");
    expect(route).toContain('candidateType === "recon_rule"');
  });

  it("posts journal and reconciles mutation atomically", () => {
    expect(route).toContain("async function postBankMutationCanonical");
    expect(route).toContain("reconciliation_status='reconciled',accounting_posted=true");
    expect(route).toContain("'CANONICAL_POSTED'");
    expect(route).toContain('return "auto_posted"');
    expect(route).toContain("auto_posted: autoPosted");
  });

  it("backfills legacy Kas Besar SC ready rows through canonical approval and posting", () => {
    expect(route).toContain("export async function runKasScApprovedRuleBackfill");
    expect(route).toContain("bizportal:kas-sc-approved-rule-backfill");
    expect(route).toContain("upper(trim(coalesce(bank_coa.code, ''))) = '1-1010-CST'");
    expect(route).toContain("upper(coalesce(bm.review_code, '')) = 'RULE_AI_MATCH'");
    expect(route).toContain("const approval = await approveBankMutation(");
    expect(route).toContain("await postBankMutationCanonical(");
    expect(route).toContain('review_code: "RULE_AI_AUTO_POSTED"');
  });

  it("rejects source override and source-less stored matches", () => {
    expect(route).toContain("CANDIDATE_SOURCE_MISMATCH");
    expect(route).toContain("selectedCandidateSource = match.candidate_source");
    expect(route).toContain("STALE_CANDIDATE");
    expect(route).not.toContain("match.candidate_source ?? requestedSource");
  });
});
