import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { reverseCanonicalSettlementForCorrection } from "../lib/reconciliation/canonicalSettlementCorrection.js";

const correction = readFileSync(
  new URL("../lib/reconciliation/canonicalSettlementCorrection.ts", import.meta.url),
  "utf8",
);
const guard = readFileSync(
  new URL("../../../../../scripts/sql/20261113_guarded_finalized_settlement_membership_compensation.sql", import.meta.url),
  "utf8",
);

describe("Issue 292: governed reversal must not bypass finalized settlement accounting", () => {
  it("preserves the pre-existing correction function rather than replacing it with a new poster", () => {
    expect(typeof reverseCanonicalSettlementForCorrection).toBe("function");
    expect(correction).toContain("FROM sport_center.accounting_journal_lines");
    expect(correction).toContain("CASE WHEN line_type = 'debit' THEN 'credit' ELSE 'debit' END");
    expect(correction).toContain("SELECT sport_center.validate_accounting_journal");
  });
  it("links a compensating journal to the exact original journal", () => {
    expect(correction).toContain('if (column === "reversal_of_id")');
    expect(correction).toContain("AND reversal_of_id = ${journalId}");
    expect(correction).toContain("reversal_settlement_journal_id");
    expect(correction).toContain("original_settlement_journal_id");
  });
  it("does not return success on idempotent retry with different bank or payment IDs", () => {
    expect(correction).toContain("Idempotent reversal request does not match the audited original correction.");
    expect(correction).toContain("originalReplacementIds.join");
  });
  it("reverses settlement before protected item membership, in the same transaction", () => {
    const statusOffset = correction.indexOf("const reversedBatch = await tx.execute");
    const membershipOffset = correction.indexOf("const reversedItems = await tx.execute");
    expect(statusOffset).toBeGreaterThan(-1);
    expect(membershipOffset).toBeGreaterThan(statusOffset);
    expect(correction).toContain("Compensation item count mismatch.");
    expect(correction).toContain("owner-audited-compensation-v1");
  });
  it("does not directly delete payments or overwrite original accounting journal headers", () => {
    expect(correction).not.toMatch(/DELETE FROM sport_center\.sport_payments/i);
    expect(correction).not.toMatch(/DELETE FROM sport_center\.accounting_journals/i);
    expect(correction).not.toMatch(/SET\s+gross_amount\s*=/i);
  });
  it("restricts finalized item mutation to reversed batch and balanced posted reversal journal", () => {
    expect(guard).toContain("TG_OP='UPDATE'");
    expect(guard).toContain("v_status='reversed'");
    expect(guard).toContain("OLD.item_status='active'");
    expect(guard).toContain("NEW.item_status='reversed'");
    expect(guard).toContain("(to_jsonb(NEW)-'item_status')");
    expect(guard).toContain("j.reversal_of_id=v_original_journal_id");
    expect(guard).toContain("j.status='posted'");
    expect(guard).toContain("FINALIZED_SETTLEMENT_ITEMS_ARE_IMMUTABLE");
  });
});
