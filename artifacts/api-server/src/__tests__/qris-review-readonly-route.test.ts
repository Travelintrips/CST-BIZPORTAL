import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const api = readFileSync(fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)), "utf8");
const ui = readFileSync(fileURLToPath(new URL("../../../bizportal/src/pages/accounting/bank-reconciliation.tsx", import.meta.url)), "utf8");

describe("QRIS unmatched booking visibility", () => {
  it("exposes a read-only mutation-scoped review endpoint", () => {
    const start = api.indexOf('router.get("/bank-reconciliation/:mutationId/qris-review"');
    const end = api.indexOf('router.post("/bank-reconciliation/qris-candidates/generate"', start);
    expect(start).toBeGreaterThan(-1);
    const route = api.slice(start, end);
    expect(route).toContain("getApprovalActor(req)");
    expect(route).toContain("listQrisReviewDiagnostics");
    expect(route).toContain("reviewOnly: true");
    expect(route).not.toContain("create_payment_settlement_batch");
    expect(route).not.toContain("finalize_payment_settlement");
    expect(route).not.toContain("prepareCanonicalQrisSettlement");
  });
  it("loads booking review without preparing settlement from the find candidate action", () => {
    expect(ui).toContain("reviewQrisPayments(mutationId)");
    expect(ui).toContain("qris_candidate_audits: candidates");
    expect(ui).toContain("qris_candidate_audit: candidates[0] ?? null");
    expect(ui).toContain("/qris-review");
  });
});
