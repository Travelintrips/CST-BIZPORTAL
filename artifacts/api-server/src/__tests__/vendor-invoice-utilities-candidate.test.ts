import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/routes/bank-reconciliation.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("vendor invoice combined utilities candidate safeguards", () => {
  const start = source.indexOf('router.post("/bank-reconciliation/:mutationId/vendor-invoice-utilities-link"');
  const end = source.indexOf('router.post("/bank-reconciliation/:mutationId/vendor-invoice-line-link"', start);
  const route = source.slice(start, end);

  it("persists a provisional candidate only and never posts payment or journal", () => {
    expect(start).toBeGreaterThan(-1);
    expect(route).toContain("'vendor_invoice_utilities_review'");
    expect(route).toContain("'provisional_review'");
    expect(route).toContain("paymentPosted:false");
    expect(route).not.toContain("insert into public.payment_allocations");
    expect(route).not.toContain("insert into public.accounting_entries");
  });

  it("requires an eligible outbound mutation and a company-scoped Draft invoice", () => {
    expect(route).toContain('String(mutation.direction).toUpperCase()!=="OUT"');
    expect(route).toContain("mutation.journal_entry_id!=null");
    expect(route).toContain("where id=$1 and company_id=$2 and cancelled_at is null");
    expect(route).toContain('invoice.status.toLowerCase()!=="draft"');
    expect(route).toContain('relation?.kind==="supporting_tax_invoice"');
  });

  it("requires one electricity line and one water line with exact net amount", () => {
    expect(route).toContain("/listrik|electricity/i");
    expect(route).toContain("/\\bair\\b|water/i");
    expect(route).toContain("electricity.length!==1 || water.length!==1");
    expect(route).toContain("Number(l.subtotal)-Number(l.withheld)");
    expect(route).toContain("Math.abs(net-amount)>0.01");
  });

  it("prevents duplicate allocations across bank movements and competing candidates", () => {
    expect(route).toContain("CANDIDATE_ALREADY_LINKED");
    expect(route).toContain("UTILITIES_ALREADY_LINKED");
    expect(route).toContain("m.mutation_id<>$2");
    expect(route).toContain("m.status in ('provisional_review','approved','posted')");
  });

  it("blocks invoice-wide batch settlement while a component review is provisional", () => {
    const batchStart = source.indexOf('router.post("/bank-reconciliation/:mutationId/vendor-invoice-payment-batch"');
    const batchEnd = source.indexOf("const invoiceResult =", batchStart);
    const batch = source.slice(batchStart, batchEnd);
    expect(batch).toContain("'vendor_invoice_utilities_review'");
    expect(batch).toContain('"COMPONENT_SETTLEMENT_REQUIRED"');
    expect(batch).toContain("Finance Review");
  });
});
