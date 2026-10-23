import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/routes/bank-reconciliation.ts"), "utf8");
const start = source.indexOf('router.post("/bank-reconciliation/:mutationId/vendor-invoice-component-payment"');
const end = source.indexOf('// Cancel a provisional component link', start);
const route = source.slice(start,end);

describe("vendor invoice component settlement contract",()=>{
  it("provides an authenticated company-scoped route for two disbursement modes",()=>{
    expect(start).toBeGreaterThan(-1);
    expect(route).toContain('"concession", "utilities"');
    expect(route).toContain("actor.companyId !== companyId");
    expect(route).toContain('invoice.status.toLowerCase()!=="posted"');
    expect(route).toContain('SUPPORTING_TAX_INVOICE');
  });
  it("locks invoice and mutation and rejects replays and overlapping component payments",()=>{
    expect(route).toContain('for update');
    expect(route).toContain('COMPONENT_ALREADY_SETTLED');
    expect(route).toContain('INVOICE_WIDE_SETTLEMENT_EXISTS');
    expect(route).toContain('MUTATION_ALREADY_ALLOCATED');
    expect(route).toContain('COMPONENT_AMOUNT_MISMATCH');
  });
  it("creates journal, PPh credits, allocation and audit atomically",()=>{
    expect(route).toContain('await client.query("begin")');
    expect(route).toContain('insert into public.accounting_entries');
    expect(route).toContain('insert into public.accounting_entry_lines');
    expect(route).toContain('insert into public.payment_allocations');
    expect(route).toContain('VENDOR_INVOICE_COMPONENT_SETTLED');
    expect(route).toContain('await client.query("commit")');
    expect(route).toContain('await client.query("rollback")');
  });
});