// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const componentSource = readFileSync(
  resolve(process.cwd(), "src/pages/accounting/bank-reconciliation.tsx"),
  "utf8",
);

type CandidateFixture = {
  candidate_type: string;
};

const realTransactionCandidateTypes = new Set([
  "sport_payment",
  "qris_settlement",
  "tenant_invoice",
  "vendor_invoice",
]);

function isRealTransactionCandidate(candidate: CandidateFixture): boolean {
  return realTransactionCandidateTypes.has(candidate.candidate_type);
}

function displayableCandidates(candidates: CandidateFixture[]): CandidateFixture[] {
  return candidates.filter(isRealTransactionCandidate);
}

describe("Rule AI required-candidate approval UI", () => {
  it("hides a Rule AI COA classification from the transaction candidate list", () => {
    const candidates = [{ candidate_type: "recon_rule" }];

    expect(displayableCandidates(candidates)).toEqual([]);
  });

  it("keeps a real transaction candidate visible while hiding the Rule AI hint", () => {
    const candidates = [
      { candidate_type: "recon_rule" },
      { candidate_type: "sport_payment" },
    ];

    expect(displayableCandidates(candidates)).toEqual([
      { candidate_type: "sport_payment" },
    ]);
  });

  it("hides Rule AI hints even when the rule does not require a source transaction", () => {
    const candidates = [{ candidate_type: "recon_rule" }];

    expect(displayableCandidates(candidates)).toEqual([]);
  });

  it("wires the runtime guard into candidate selection and approval actions", () => {
    expect(componentSource).toContain('m.review_code === "RULE_CANDIDATE_REQUIRED"');
    expect(componentSource).toContain("isRealTransactionCandidate(candidate)");
    expect(componentSource).toContain("matchingCandidates.filter(isRealTransactionCandidate)");
    expect(componentSource).toContain("candidateSelectionEnabled && candidateIsSelectable");
    expect(componentSource).toContain("onApproveCandidate && canApprove(m) && candidateIsSelectable");
    expect(componentSource).toContain("candidate.amount_match");
    expect(componentSource).toContain("candidate.date_match");
    expect(componentSource).toContain("candidate.name_match");
    expect(componentSource).toContain(
      "|| candidate.date_match",
    );
    expect(componentSource).toContain(
      "Approve baru tersedia setelah ditemukan",
    );
  });
  it("does not offer approval for unsupported legacy transaction candidates", () => {
    const candidates = [
      { candidate_type: "logistic_order" },
      { candidate_type: "invoice" },
      { candidate_type: "expense" },
      { candidate_type: "accounting_payment" },
      { candidate_type: "internal_transfer" },
    ];
    expect(displayableCandidates(candidates)).toEqual([]);
    expect(componentSource).not.toContain('"logistic_order",\n  "invoice",\n  "expense",');
  });

});
