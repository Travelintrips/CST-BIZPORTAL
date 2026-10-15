import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const route = readFileSync(
  fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)),
  "utf8",
);

describe("Sport Center reconciliation ambiguity contract", () => {
  it("includes booking identity in Sport Center candidate scoring", () => {
    expect(route).toContain("sb.customer_name as booking_customer_name");
    expect(route).toContain("sb.order_number as booking_order_number");
    expect(route).toContain('"Nominal, tanggal, dan nama customer cocok."');
  });

  it("persists every competitive canonical candidate instead of silently keeping the first", () => {
    // Only rule-relevant candidates may compete; otherwise unrelated receipts
    // could force a false ambiguity or be persisted as potential matches.
    expect(route).toContain(
      "const ruleCandidates = candidates.filter((candidate) =>",
    );
    expect(route).toContain("candidateRelevantToRule(matchedRule, candidate)");
    expect(route).toContain("const realCandidate = ruleCandidates[0]");
    expect(route).toContain(
      "ruleCandidates.filter((candidate) => candidate.score >= realCandidate.score - 5)",
    );
    expect(route).toContain("for (const candidate of competitiveRealCandidates)");
    expect(route).toContain("RULE_MULTIPLE_CANONICAL_CANDIDATES");
    expect(route).toContain("real_candidate_ids: competitiveRealCandidates.map");
  });

  it("uses manual review for ambiguous local candidates and preserves their identities", () => {
    expect(route).toContain("for (const candidate of competitiveCandidates)");
    expect(route).toContain('"MULTIPLE_CANDIDATES"');
    expect(route).toContain("customer_name, order_ref");
    expect(route).toContain("candidate.customerName ?? null");
    expect(route).not.toContain('? "duplicate_need_review"');
  });
});
