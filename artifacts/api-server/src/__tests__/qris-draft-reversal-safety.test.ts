import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Deliberately inspect the pending writer without importing or executing it.
// The financial writer must NOT become reachable from the active BizPortal API
// until rollback, duplicate, 2-cohort rebuild and bank approval tests pass.
const pendingCorrection = readFileSync(
  new URL("../../../../.upstream-cst-super-app/artifacts/api-server/src/lib/reconciliation/canonicalSettlementCorrection.ts", import.meta.url),
  "utf8",
);
const scopedTrigger = readFileSync(
  new URL("../../../../scripts/sql/20261113_guarded_finalized_settlement_membership_compensation.sql", import.meta.url),
  "utf8",
);

describe("Issue 292 draft compensation safety boundary", () => {
  it("requires explicit source journal reversal and immutable source lines", () => {
    expect(pendingCorrection).toContain('if (column === "reversal_of_id")');
    expect(pendingCorrection).toContain("CASE WHEN line_type = 'debit' THEN 'credit' ELSE 'debit' END");
    expect(pendingCorrection).toContain("SELECT sport_center.validate_accounting_journal");
    expect(pendingCorrection).toContain("AND reversal_of_id = ${journalId}");
  });
  it("rejects idempotency requests for a different bank ID or payment set", () => {
    expect(pendingCorrection).toContain("Idempotent reversal request does not match the audited original correction.");
    expect(pendingCorrection).toContain("originalReplacementIds.join");
  });
  it("reverses batch before finalized memberships using exact compensated journal", () => {
    const reversedBatch = pendingCorrection.indexOf("const reversedBatch = await tx.execute");
    const reversedItems = pendingCorrection.indexOf("const reversedItems = await tx.execute");
    expect(reversedBatch).toBeGreaterThan(-1);
    expect(reversedItems).toBeGreaterThan(reversedBatch);
    expect(scopedTrigger).toContain("v_status='reversed'");
    expect(scopedTrigger).toContain("j.reversal_of_id=v_original_journal_id");
    expect(scopedTrigger).toContain("j.status='posted'");
  });
  it("rejects financial-field writes or deletes on finalized items", () => {
    expect(scopedTrigger).toContain("OLD.item_status='active'");
    expect(scopedTrigger).toContain("NEW.item_status='reversed'");
    expect(scopedTrigger).toContain("(to_jsonb(NEW)-'item_status')");
    expect(scopedTrigger).toContain("FINALIZED_SETTLEMENT_ITEMS_ARE_IMMUTABLE");
  });
  it("clears stale matched status and QRIS review projection together", () => {
    expect(pendingCorrection).toContain("reconciliation_status = 'unmatched'");
    expect(pendingCorrection).toContain("review_code = 'QRIS_MEMBERSHIP_CORRECTION_PENDING'");
    expect(pendingCorrection).toContain("SET status = 'unmatched'");
    expect(pendingCorrection).toContain("SET status = 'superseded'");
  });
  it("keeps pending upstream financial writer out of active reconciliation route", () => {
    const liveRoute = readFileSync(
      new URL("../routes/bank-reconciliation.ts", import.meta.url),
      "utf8",
    );
    expect(liveRoute).not.toContain("reverseCanonicalSettlementForCorrection");
    expect(liveRoute).toContain("inspectPostedUnlinkedBankCohorts");
  });
});
