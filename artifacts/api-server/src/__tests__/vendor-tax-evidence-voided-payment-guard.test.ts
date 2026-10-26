import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const api = readFileSync(resolve(process.cwd(), "src/routes/purchase-workflow.ts"), "utf8");
const ui = readFileSync(resolve(process.cwd(), "../bizportal/src/pages/purchase/vendor-invoices.tsx"), "utf8");
const reviewGate = readFileSync(
  resolve(process.cwd(), "../../scripts/sql/20261027_cst_finance_review_posting_gate.sql"),
  "utf8",
);

describe("reviewed tax evidence and reversed bank disbursement visibility", () => {
  it("treats extracted supplier PDFs as unverified source evidence, not a posted tax approval", () => {
    expect(api).toContain("taxReviewStatus: row.tax_review_status");
    expect(api).toContain("taxReviewReason: row.tax_review_reason");
    expect(api).toContain("supportingTaxDocument: row.supporting_tax_candidate_id == null ? null : {");
    expect(api).toContain("verified: false");
    expect(api).toContain("support.status='supporting'");
    expect(api).toContain("support.extracted_tax=vi.tax_amount");
    expect(api).toContain("source_invoice.gmail_message_id=support.gmail_message_id");
    expect(ui).toContain("Ekstraksi bukan verifikasi keaslian Faktur Pajak");
  });
  it("exposes only reversed voided bank disbursements with same-company invoice linkage", () => {
    expect(api).toContain("bd.status='voided'");
    expect(api).toContain("rev.source::text='reversal'");
    expect(api).toContain("rev.source_id=bd.entry_id");
    expect(api).toContain("bdi.vendor_invoice_id=vi.id");
    expect(api).toContain("linkedVoidedDisbursementNumbers: row.linked_voided_disbursement_numbers");
    expect(ui).toContain("Bank Disbursement historis sudah dibatalkan");
    expect(ui).toContain("!(vi.linkedVoidedDisbursementNumbers?.length)");
  });
  it("blocks posting unreviewed corrective journals without bypassing posting for other journals", () => {
    expect(reviewGate).toContain("coalesce(old.governance_flags->>'finance_review_required','false')='true'");
    expect(reviewGate).toContain("FINANCE_REVIEW_REQUIRED");
    expect(reviewGate).toContain("old.status::text = 'draft'");
    expect(reviewGate).toContain("new.status::text in ('approved','posted','pending_approval')");
    expect(reviewGate).not.toMatch(/disable trigger/i);
    expect(reviewGate).not.toMatch(/delete from public.accounting_entries/i);
  });
});
