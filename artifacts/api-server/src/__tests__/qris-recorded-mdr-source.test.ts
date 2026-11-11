import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/lib/reconciliation/qrisReviewDiagnostics.ts"),
  "utf8",
);

describe("QRIS read-only MDR evidence", () => {
  it("reads persisted payment MDR instead of only provider aggregate rate", () => {
    expect(source).toContain("sp.mdr_amount as mdr_amount");
    expect(source).toContain("coalesce(sp.mdr_rate, config.mdr_rate, 0.007)");
  });

  it("retains an explicit zero MDR as the authoritative amount", () => {
    expect(source).toContain("payment.mdr_amount == null ? null : safeNumber(payment.mdr_amount)");
    expect(source).toContain("recorded != null && recorded >= 0");
    expect(source).toContain("mdrAmount: paymentMdr(payment)");
  });

  it("never upgrades a read-only review snapshot to approval authority", () => {
    expect(source).toContain("current_evidence_valid: false");
  });
  it("surfaces a dynamic policy preview without silently replacing recorded MDR", () => {
    expect(source).toContain("calculateQrisCandidatePreview({ payments: previewPayments, candidatesComplete: false })");
    expect(source).toContain("policy_mdr_preview_final: null");
    expect(source).toContain("policy_mdr_source_difference:");
    expect(source).toContain("mdr_amount: mdr,");
  });
});
