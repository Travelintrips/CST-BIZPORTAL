import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const route = readFileSync(new URL("../routes/purchaseWorkflow.ts", import.meta.url), "utf8");
const reversal = route.slice(
  route.indexOf('router.post("/vendor-invoices/:id/reverse"'),
  route.indexOf("// PAYMENT REQUESTS", route.indexOf('router.post("/vendor-invoices/:id/reverse"')),
);

describe("Vendor Invoice reversal safety contract", () => {
  it("keeps the reporting-view fail-closed gate before posting", () => {
    expect(reversal).toContain("vendor_invoice_reversal_pair");
    expect(reversal.indexOf("vendor_invoice_reversal_pair")).toBeLessThan(reversal.indexOf("postEntryWithClient(tx,"));
  });

  it("verifies returned idempotent journal identity and reverse financial signature before voiding", () => {
    expect(reversal).toContain('reversal.source !== "reversal"');
    expect(reversal).toContain("reversal.sourceId !== original.id");
    expect(reversal).toContain("reversal.companyId !== companyId");
    expect(reversal).toContain("reversal.id === original.id");
    expect(reversal).toContain("persistedReversalLines.length !== lines.length");
    expect(reversal).toContain("financialSignature(persistedReversalLines) !== expectedReversalSignature");
    expect(reversal.indexOf("financialSignature(persistedReversalLines)")).toBeLessThan(
      reversal.indexOf("await tx.update(accountingEntriesTable).set("),
    );
  });

  it("serializes reversal attempts and refuses linked payments or bank reconciliations", () => {
    expect(reversal).toContain("FOR UPDATE");
    expect(reversal).toContain("accounting_payments");
    expect(reversal).toContain("vendor_payments");
    expect(reversal).toContain("bank_mutations");
    expect(reversal).toContain("bank_reconciliation_matches");
  });
});
