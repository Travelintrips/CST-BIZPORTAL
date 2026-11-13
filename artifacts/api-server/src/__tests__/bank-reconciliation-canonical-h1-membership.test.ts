import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../routes/bank-reconciliation.ts", import.meta.url), "utf8",
);
const approval = source.slice(
  source.indexOf("async function approveCanonicalSettlementLink("),
  source.indexOf("async function approveBankMutation("),
);

describe("QRIS canonical historical membership H+1 protection", () => {
  it("excludes posted canonical batches containing a wrong H+1 member at candidate discovery", () => {
    const discovery = source.slice(
      source.indexOf("const canonicalQrisSettlements = await client.query"),
      source.indexOf("for (const settlement of canonicalQrisSettlements.rows)"),
    );
    expect(discovery).toContain("and not exists (");
    expect(discovery).toContain("from sport_center.payment_settlement_items si");
    expect(discovery).toContain("sp.paid_at at time zone 'Asia/Jakarta'");
    expect(discovery).toContain("sp.expected_settlement_date::date is distinct from psb.settlement_date");
    expect(discovery).toContain("sp.bank_account_id is distinct from psb.bank_account_id");
    expect(discovery).toContain("sp.company_id is distinct from psb.company_id");
  });
  it("rejects an old candidate already persisted before approval", () => {
    expect(approval).toContain("payment.paid_at at time zone 'Asia/Jakarta'");
    expect(approval).toContain("payment.expected_settlement_date::date is distinct from $5::date");
    expect(approval).toContain("CANONICAL_SETTLEMENT_PAYMENT_INVALID");
    expect(approval).toContain("payment.company_id is distinct from $2::integer");
    expect(approval).toContain("payment.bank_account_id is distinct from $4::text");
  });
  it("validates recorded gross and MDR against current active source payments", () => {
    expect(approval).toContain("sum(si.gross_amount)");
    expect(approval).toContain("sum(sp.mdr_amount)");
    expect(approval).toContain("CANONICAL_SETTLEMENT_MEMBER_TOTALS_INVALID");
  });
  it("keeps canonical approval link-only and blocks generic bank posting", () => {
    expect(approval).toContain("journal_entry_id=null");
    expect(source).toContain("CANONICAL_SETTLEMENT_GENERIC_POST_BLOCKED");
  });
});
