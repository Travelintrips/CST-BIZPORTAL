import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const api = readFileSync(resolve(process.cwd(), "src/routes/purchase-workflow.ts"), "utf8");
const ui = readFileSync(resolve(process.cwd(), "../bizportal/src/pages/purchase/vendor-invoices.tsx"), "utf8");

describe("historical orphan bank disbursement guard", () => {
  it("only warns on a matching original supplier ref and exact gross amount when original link is missing and journal reversed", () => {
    expect(api).toContain("bd.ref = vi.vendor_invoice_ref");
    expect(api).toContain("bdi.amount + coalesce(bdi.wht_amount, 0) = vi.grand_total");
    expect(api).toContain("where original_invoice.id = bdi.vendor_invoice_id");
    expect(api).toContain("reversed_entry.source::text = 'reversal'");
    expect(api).toContain("reversed_entry.status::text = 'posted'");
    expect(api).toContain("orphanDisbursementNumbers: row.orphan_disbursement_numbers");
  });

  it("does not treat a reversed orphan record as a paid allocation or offer a duplicate shortcut", () => {
    expect(api).toContain("amountPaid: row.reconciled_amount_paid");
    expect(ui).toContain("Periksa Bank Disbursement historis sebelum membayar lagi");
    expect(ui).toContain("!(vi.orphanDisbursementNumbers?.length)");
    expect(ui).toContain("Catatan ini bukan bukti pembayaran final");
  });
});
