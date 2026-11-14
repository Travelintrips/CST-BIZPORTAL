import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * #292: keep the replacement stage bound to the genuine owner functions,
 * not fixture-only SQL INSERTs or a second independent transaction.
 */
const source = readFileSync(
  new URL("../lib/reconciliation/canonicalSettlementCorrectionCoordinator.ts", import.meta.url),
  "utf8",
);
const rebuild = source.slice(source.indexOf("export async function rebuildIssue292WithOwnerFunctions("));

describe("Issue 292 canonical rebuild integration contract", () => {
  it("uses the real canonical and supplemental owner builders in the same transaction", () => {
    expect(rebuild).toContain("sport_center.create_payment_settlement_batch(");
    expect(rebuild).toContain("sport_center.create_payment_settlement_supplemental_batch(");
    expect(rebuild).toContain("sport_center.canonical_settlement_group_identity(");
    // Owner canonical builder accepts settlement_reference, not correlation_id.
    // The underlying wrapper currently recomputes the value, but never rely
    // on that implicit behavior in the audited correction path.
    expect(rebuild).toContain("SELECT settlement_reference FROM sport_center.canonical_settlement_group_identity(");
    expect(rebuild).toContain("?.settlement_reference??");
    expect(rebuild).not.toContain("SELECT correlation_id FROM sport_center.canonical_settlement_group_identity(");
    expect(rebuild).toContain("sport_center.create_settlement_journal_draft(");
    expect(rebuild).toContain("sport_center.finalize_payment_settlement(");
    expect(rebuild).not.toMatch(/INSERT INTO sport_center\.(?:payment_settlement_batches|accounting_journals)/i);
    expect(rebuild).not.toContain("client.transaction(");
  });

  it("blocks wrong day, missing source journals and stale payment statuses before owner writes", () => {
    expect(rebuild).toContain("p.paid_at AT TIME ZONE 'Asia/Jakarta'");
    expect(rebuild).toContain("row.h_plus_one!==cohort.date");
    expect(rebuild).toContain("row.expected_date!==cohort.date");
    expect(rebuild).toContain("Number(row.source_journal_count)!==1");
    expect(rebuild).toContain('String(row.settlement_status).toLowerCase()!=="unsettled"');
    const firstWriter=rebuild.indexOf("sport_center.create_payment_settlement_supplemental_batch(");
    expect(firstWriter).toBeGreaterThan(rebuild.indexOf('row.h_plus_one!==cohort.date'));
    expect(firstWriter).toBeGreaterThan(rebuild.indexOf('source totals fail exact bank evidence'));
  });

  it("fails closed on actual owner-calculated gross MDR net and payment membership before journal draft", () => {
    expect(rebuild).toContain("b.gross_amount,b.mdr_amount,b.net_amount");
    expect(rebuild).toContain("ARRAY(SELECT i.payment_id FROM sport_center.payment_settlement_items i");
    expect(rebuild).toContain("Number(calculatedRow.mdr_amount)!==cohort.mdr");
    expect(rebuild).toContain("Number(calculatedRow.net_amount)!==cohort.net");
    expect(rebuild).toContain('builtPayments.join(",")!==cohort.ids.join(",")');
    const mismatch=rebuild.indexOf("owner-calculated batch differs from exact bank gross/MDR/net or membership");
    const draft=rebuild.indexOf("sport_center.create_settlement_journal_draft(");
    expect(mismatch).toBeGreaterThan(0);
    expect(draft).toBeGreaterThan(mismatch);
  });

  it("requires both authentic unmatched bank mutations before owner batch writers", () => {
    expect(rebuild).toContain("WHERE m.id IN (434462,434464)");
    expect(rebuild).toContain("FOR UPDATE OF m,a");
    expect(rebuild).toContain('row.source_classification!=="actual_bank_mutation"');
    expect(rebuild).toContain('row.status!=="unmatched"');
    expect(rebuild).toContain('row.reconciliation_status!=="unmatched"');
    expect(rebuild).toContain("candidate.status='approved'");
    expect(rebuild).toContain("row.has_prior_approved_match!==false");
    expect(rebuild).toContain("AS has_prior_approved_match");
    expect(rebuild).toContain("row.journal_entry_id!=null");
    expect(rebuild).toContain("row.approved_at!=null");
    expect(rebuild).toContain("row.posted_at!=null");
    expect(rebuild.indexOf("Issue #292 bank evidence mismatch"))
      .toBeLessThan(rebuild.indexOf("sport_center.create_payment_settlement_batch("));
  });

  it("preserves historical #5738 and blocks external bank approval or deployment by itself", () => {
    expect(rebuild).toContain("reversal.settlementId !== 5738");
    expect(rebuild).toContain("reversal.bankMutationId !== 434464");
    expect(rebuild).toContain('"2026-11-04"');
    expect(rebuild).toContain('"2026-11-05"');
    expect(rebuild).toContain("1-1023-CST");
    expect(rebuild).not.toContain("UPDATE public.bank_mutations");
    expect(rebuild).not.toContain("router.post(");
  });
});
