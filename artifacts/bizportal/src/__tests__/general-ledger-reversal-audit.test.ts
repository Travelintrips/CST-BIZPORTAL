import { describe, expect, it } from "vitest";
import { canReverseFromLedger, ledgerReversalState } from "@/lib/generalLedgerReversal";

describe("general ledger reversal audit", () => {
  it("identifies a posted reversal by the underlying source, even if source_module is null", () => {
    const row = { status: "posted", source: "reversal", source_module: null };
    expect(ledgerReversalState(row)).toBe("reversal");
    expect(canReverseFromLedger(row)).toBe(false);
  });
  it("identifies a posted original already offset by a posted reversal", () => {
    const row = { status: "posted", source: "purchase_bill", reversal_entry_number: "PUR-CST/2026/000001" };
    expect(ledgerReversalState(row)).toBe("reversed");
    expect(canReverseFromLedger(row)).toBe(false);
  });
  it("only permits reversing an ordinary posted original", () => {
    expect(canReverseFromLedger({ status: "posted", source: "purchase_bill" })).toBe(true);
    expect(canReverseFromLedger({ status: "draft", source: "manual" })).toBe(false);
  });
});
