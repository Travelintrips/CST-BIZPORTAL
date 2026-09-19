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

  it("resolves local QRIS payment scope to a canonical settlement before journal approval", () => {
    expect(source).toContain("async function resolveCanonicalQrisSettlement(");
    expect(source).toContain("sport_center.payment_settlement_items");
    expect(source).toContain("psi.item_status = 'active'");
    expect(source).toContain("in ('posted', 'reconciled')");
    expect(source).toContain("CANONICAL_SETTLEMENT_REQUIRED");
    expect(source).toContain("result.rows.length > 1");
    expect(source).toContain("CANONICAL_SETTLEMENT_SELECTION_CONFLICT");
    expect(source).toContain("const canonicalSettlementId = await resolveCanonicalQrisSettlement(");
    expect(source).toContain("id::text = $1::text");
    expect(source).toContain('candidate_source: "sport_center.payment_settlement_batches"');
    expect(source).not.toContain('candidate_source: "local.qris_mutation_batch_candidates"');

    const resolverStart = source.indexOf("async function resolveCanonicalQrisSettlement(");
    const resolverEnd = source.indexOf("async function listQrisCanonicalSettlements(", resolverStart);
    const resolver = source.slice(resolverStart, resolverEnd);
    expect(resolver).not.toContain("limit 1");

    const approval = source.indexOf("const approval = await approveBankMutation(", resolverEnd);
    const candidateUpdate = source.indexOf(
      "update public.qris_mutation_batch_candidates",
      approval,
    );
    expect(approval).toBeGreaterThan(resolverEnd);
    expect(candidateUpdate).toBeGreaterThan(approval);
  });

  it("supersedes competing non-final candidates before approving the selected match", () => {
    expect(source).toContain("set status = 'superseded'");
    expect(source).toContain("and id <> $2");
    expect(source).toContain("and status not in ('approved', 'posted')");
  });
});
