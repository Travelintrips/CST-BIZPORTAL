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
    expect(source).toContain('"historical_qris_review_snapshot",\n      "live_qris_review_snapshot"');
    expect(source).toContain("candidate.current_evidence_valid !== false");
  });

  it("allows one-day-earlier payment evidence only for read-only diagnostics", () => {
    expect(source).toContain("readOnlyReviewSnapshot");
    expect(source).toContain("Canonical/approvable candidates keep the strict same-date contract.");
  });
});
