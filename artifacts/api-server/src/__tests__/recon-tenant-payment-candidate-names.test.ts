import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const api = readFileSync(fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)), "utf8");
const ui = readFileSync(fileURLToPath(new URL("../../../bizportal/src/pages/accounting/bank-reconciliation.tsx", import.meta.url)), "utf8");
describe("tenant payment candidate display identity", () => {
  it("keeps tenant payment as canonical ID, while exposing actual tenant business name", () => {
    expect(api).toContain('candidateType: "tenant_invoice"');
    expect(api).toContain('candidateId: payment.id');
    expect(api).toContain('customerName: payment.tenant_name');
    expect(api).toContain('t.business_name as tenant_name');
    expect(api).toContain("match.candidate_source = 'public.tenant_payments'");
    expect(api).toContain('tp.id = match.candidate_id and tp.company_id = bm.company_id');
  });
  it("shows tenant name and payment ID without presenting the payment as an invoice", () => {
    expect(ui).toContain('tenant_invoice: "Pembayaran Tenant"');
    expect(ui).toContain('candidateName} — Pembayaran #');
    expect(ui).toContain('ID Pembayaran #');
  });
});
