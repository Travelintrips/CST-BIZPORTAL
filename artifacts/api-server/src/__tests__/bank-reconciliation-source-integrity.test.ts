import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/routes/bank-reconciliation.ts"),
  "utf8",
);

describe("bank reconciliation candidate source integrity", () => {
  it("persists canonical source identities for locally generated candidates", () => {
    expect(source).toContain('"sport_center.sport_payments"');
    expect(source).toContain('"public.vendor_invoices"');
    expect(source).toContain("status, candidate_source");
  });

  it("revalidates the selected source before journal creation", () => {
    const validation = source.indexOf("await assertApprovalCandidateExists(");
    const journalLookup = source.indexOf("from public.accounting_journals", validation);
    expect(validation).toBeGreaterThan(-1);
    expect(journalLookup).toBeGreaterThan(validation);
  });

  it("fails closed for stale and legacy QRIS candidates", () => {
    expect(source).toContain('"STALE_CANDIDATE"');
    expect(source).toContain('candidateSource !== "sport_center.payment_settlement_batches"');
    expect(source).toContain("QRIS settlement legacy/tanpa source canonical tidak dapat di-approve.");
  });

  it("resolves local QRIS payment scope to a canonical settlement before journal approval", () => {
    expect(source).toContain("async function resolveCanonicalQrisSettlement(");
    expect(source).toContain("sport_center.payment_settlement_items");
    expect(source).toContain("CANONICAL_SETTLEMENT_REQUIRED");
    expect(source).toContain("const canonicalSettlementId = await resolveCanonicalQrisSettlement(");
    expect(source).toContain('candidate_source: "sport_center.payment_settlement_batches"');
    expect(source).not.toContain('candidate_source: "local.qris_mutation_batch_candidates"');
  });

  it("supersedes competing non-final candidates before approving the selected match", () => {
    expect(source).toContain("set status = 'superseded'");
    expect(source).toContain("and id <> $2");
    expect(source).toContain("and status not in ('approved', 'posted')");
  });
});
