import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const api = readFileSync(fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)), "utf8");
const localMatching = api.slice(api.indexOf("const tenantPayments = await"), api.indexOf("for (const payment of tenantPayments.rows)"));
const approvalGuard = api.slice(api.indexOf('} else if (candidateType === "tenant_invoice")'), api.indexOf('} else if (candidateType === "recon_rule")'));

describe("Approved tenant payment with posted source journal", () => {
  for (const sql of [localMatching, approvalGuard]) {
    it("allows legacy pending only with confirmed approval, paid invoice and exact posted source journal", () => {
      expect(sql).toContain("= 'pending'");
      expect(sql).toContain("= 'approved'");
      expect(sql).toContain("ti_paid.status::text = 'paid'");
      expect(sql).toContain("ti_paid.outstanding_amount = 0");
      expect(sql).toContain("source_entry.source::text = 'tenant_rent_payment'");
      expect(sql).toContain("source_entry.status = 'posted'");
      expect(sql).toContain("source_entry.source_id =");
      expect(sql).toContain("source_entry.total_debit::numeric");
      expect(sql).toContain("source_entry.total_credit::numeric");
      expect(sql).toContain("is_voided, false");
      expect(sql).toContain("duplicate_of_payment_id");
    });
  }
  it("does not remove source journal reuse or duplicate candidate safeguards", () => {
    expect(api).toContain("finalizeSourceJournalReuse(");
    expect(api).toContain("assertSourceOwnedCandidateNotReconciledElsewhere(");
    expect(api).toContain("SOURCE_JOURNAL_REUSED");
  });
});
