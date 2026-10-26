import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const api = readFileSync(resolve(process.cwd(), "src/routes/purchase-workflow.ts"), "utf8");
const ui = readFileSync(resolve(process.cwd(), "../bizportal/src/pages/purchase/vendor-invoices.tsx"), "utf8");

describe("vendor invoice accounting reversal guard", () => {
  it("returns reversal linkage without changing canonical paid amount", () => {
    expect(api).toContain("journalReversalEntryId: row.reversal_journal_id");
    expect(api).toContain("amountPaid: row.reconciled_amount_paid");
  });
  it("warns when invoice remains posted but its original posting is reversed", () => {
    expect(ui).toContain("Jurnal invoice ini sudah dibalik");
    expect(ui).toContain("!!vi?.journalReversalEntryId");
    expect(ui).toContain("!vi.journalReversalEntryId && !(vi.orphanDisbursementNumbers?.length)");
    expect(ui).toContain("Periksa Buku Besar");
  });
});
