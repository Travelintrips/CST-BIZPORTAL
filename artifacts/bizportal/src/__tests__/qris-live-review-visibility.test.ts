import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/pages/accounting/bank-reconciliation.tsx"),
  "utf8",
);

describe("QRIS live review visibility", () => {
  it("renders live review snapshots as read-only candidate evidence", () => {
    expect(source).toContain('"live_qris_review_snapshot"');
    expect(source).toContain("isReadOnlyReviewSnapshot");
    expect(source).toContain("readOnlyReviewSnapshot");
  });

  it("never exposes live review snapshots through QRIS approval selection", () => {
    const eligibility = source.match(
      /const isQrisCandidateEligible\s*=\s*\(candidate:\s*QrisCandidateAudit\)[\s\S]*?const qrisApprovableCandidates/,
    )?.[0];
    expect(eligibility).toBeDefined();
    expect(eligibility).toMatch(
      /"historical_qris_review_snapshot"\s*,\s*"live_qris_review_snapshot"/,
    );
    expect(eligibility).toContain("candidate.current_evidence_valid !== false");
    expect(eligibility).toContain("getUnconfirmedQrisPaymentIds(candidate).length === 0");
    expect(eligibility).toContain("getAvailableQrisPaymentIds(candidate).length > 0");
  });

  it("allows one-day-earlier payment evidence only for read-only diagnostics", () => {
    expect(source).toContain("readOnlyReviewSnapshot");
    expect(source).toContain("Canonical/approvable candidates keep the strict same-date contract.");
  });
});
