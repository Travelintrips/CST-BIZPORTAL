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

  it("uses canonical QRIS settlements only", () => {
    expect(source).toContain("sport_center.payment_settlement_batches");
    expect(source).toContain("sport_center.payment_settlement_items");
    expect(source).toContain("canonical_qris_settlement");
    expect(source).toContain("LEGACY_QRIS_GENERATOR_REMOVED");
    expect(source).toContain("LEGACY_QRIS_APPROVAL_REMOVED");
    expect(source).not.toContain("qris_mutation_batch_candidates");
    expect(source).not.toContain("update public.qris_mutation_batch_candidates");
  });

  it("rejects legacy source-less matches and accounting_payment candidates", () => {
    expect(source).toContain("Kandidat lama tanpa candidate_source canonical tidak dapat di-approve");
    expect(source).not.toContain('candidateType === "accounting_payment"');
    expect(source).not.toContain('selectedCandidateType === "accounting_payment"');
    expect(source).not.toContain('selectedCandidateSource = match.candidate_source ?? requestedSource');
  });

  it("supersedes competing non-final candidates before approving the selected match", () => {
    expect(source).toContain("set status = 'superseded'");
    expect(source).toContain("and id <> $2");
    expect(source).toContain("and status not in ('approved', 'posted')");
  });
  it("approves canonical QRIS settlement as link-only without generic journal creation", () => {
    expect(source).toContain("async function approveCanonicalSettlementLink");
    expect(source).toContain("CANONICAL_SETTLEMENT_LINK_APPROVED");
    expect(source).toContain("status='reconciled',bank_mutation_id=$2,reconciled_at=now(),reconciled_by=$3");
    expect(source).toContain("set status='approved',reconciliation_status='approved',journal_entry_id=null");
    const branch = source.indexOf('selectedCandidateType === "qris_settlement"');
    const bankResolution = source.indexOf("const bankCoaId = await resolveApprovalBankAccount", branch);
    expect(branch).toBeGreaterThan(-1);
    expect(bankResolution).toBeGreaterThan(branch);
    expect(source.slice(branch, bankResolution)).toContain("return approveCanonicalSettlementLink(");
  });

  it("uses total grouped Sport Center payment amount and source-qualified exclusions", () => {
    expect(source).toContain("sum(sp.amount::numeric) as amount");
    expect(source).not.toContain("max(sp.amount::numeric) as amount");
    expect(source).toContain("brm.candidate_source = 'sport_center.sport_payments'");
    expect(source).toContain("brm.candidate_source = 'public.tenant_payments'");
    expect(source).toContain("brm.candidate_source = 'public.vendor_invoices'");
  });

});
