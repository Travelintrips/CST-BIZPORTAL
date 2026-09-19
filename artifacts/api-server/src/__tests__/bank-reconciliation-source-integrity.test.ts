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

  it("matches vendor invoices by canonical allocation balance", () => {
    expect(source).toContain("from public.payment_allocations pa");
    expect(source).toContain("join public.payment_matching_groups pmg on pmg.id = pa.group_id");
    expect(source).toContain("coalesce(pa.is_active, true) = true");
    expect(source).toContain("lower(coalesce(pmg.status, '')) in ('posted', 'reconciled')");
    expect(source).toContain("greatest(vi.grand_total::numeric - coalesce(cip.canonical_paid, 0), 0)");
    expect(source).not.toContain("vendor_invoices.amount_paid");
  });

  it("repairs a missing approved match only from one deterministic source-qualified candidate", () => {
    expect(source).toContain("APPROVED_MATCH_REPAIRED");
    expect(source).toContain("candidate_source is not null");
    expect(source).toContain("status in ('candidate','matched','selected')");
    expect(source).toContain('entry?.source !== "bank_reconciliation"');
    expect(source).toContain("recoverableMatch.rows.length !== 1");
  });

  it("allows approved draft cancellation only while the linked journal is still draft", () => {
    expect(source).toContain('"approved_pending_posting",\n      "approved",');
    expect(source).toContain('String(mutation.journal_status ?? "").toLowerCase() !== "draft"');
    expect(source).toContain("Approval hanya dapat dibatalkan bila jurnal terkait masih berstatus draft.");
    expect(source).toContain("where id = $1 and status = 'draft'");
    expect(source).toContain("set status = 'superseded'");
  });

  it("prefers the posted payment_confirmed journal over one stale draft duplicate", () => {
    expect(source).toContain('const existingPosted = existing.status === "posted"');
    expect(source).toContain('const incomingPosted = journal.status === "posted"');
    expect(source).toContain("if (existingPosted !== incomingPosted)");
    expect(source).toContain("if (incomingPosted) journalByPayment.set(journal.payment_id, journal)");
    expect(source).toContain("lebih dari satu jurnal payment_confirmed dengan status finansial yang sama");
  });

  it("does not project stale legacy candidates back to the reconciliation UI", () => {
    expect(source).toContain("match.candidate_source is not null");
    expect(source).toContain("match.candidate_type = 'sport_payment' and match.candidate_source = 'sport_center.sport_payments'");
    expect(source).toContain("match.candidate_type = 'tenant_invoice' and match.candidate_source = 'public.tenant_payments'");
    expect(source).toContain("match.candidate_type = 'vendor_invoice' and match.candidate_source = 'public.vendor_invoices'");
    expect(source).toContain("match.candidate_type = 'qris_settlement' and match.candidate_source = 'sport_center.payment_settlement_batches'");
  });

});
