import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  new URL("../routes/index.ts", import.meta.url),
  "utf8",
);

describe("standalone BizPortal API boundary", () => {
  it("does not proxy unknown API routes to CST-SUPER-APP", () => {
    expect(routeSource).not.toContain("getConfiguredUpstreamOrigin");
    expect(routeSource).not.toContain("buildUpstreamUrl");
    expect(routeSource).not.toContain("requestUpstream");
    expect(routeSource).not.toContain("bizportal_upstream_");
    expect(routeSource).toContain("BIZPORTAL_LOCAL_ENDPOINT_NOT_FOUND");
  });

  it("keeps authentication owned by BizPortal", () => {
    expect(routeSource).toContain("router.use(createDevAuthRouter());");
    expect(routeSource).toContain("router.use(localProductionAuthRouter);");
    expect(routeSource).not.toContain("establishDevelopmentUpstreamSession");
    expect(routeSource).not.toContain("establishProductionUpstreamSession");
  });



  it("keeps Vendor Invoice AP endpoints owned by the standalone BizPortal backend", () => {
    const purchaseWorkflowSource = readFileSync(
      new URL("../routes/purchase-workflow.ts", import.meta.url),
      "utf8",
    );

    expect(routeSource).toContain('import purchaseWorkflowRouter from "./purchase-workflow";');
    expect(routeSource).toContain("router.use(purchaseWorkflowRouter);");
    expect(routeSource.indexOf("router.use(purchaseWorkflowRouter);")).toBeLessThan(
      routeSource.indexOf("BIZPORTAL_LOCAL_ENDPOINT_NOT_FOUND"),
    );
    expect(purchaseWorkflowSource).toContain(
      'router.get("/purchase-workflow/vendor-invoices"',
    );
    expect(purchaseWorkflowSource).toContain(
      'router.get("/purchase-workflow/vendor-invoices/:id"',
    );
    expect(purchaseWorkflowSource).not.toContain("requestUpstream");
    expect(purchaseWorkflowSource).not.toContain('next("router");');
    expect(purchaseWorkflowSource).not.toContain("req.originalUrl");
  });

  it("implements local bank reconciliation approval with an atomic journal transaction", () => {
    const bankReconciliationSource = readFileSync(
      new URL("../routes/bank-reconciliation.ts", import.meta.url),
      "utf8",
    );

    expect(bankReconciliationSource).toContain(
      'router.post("/bank-reconciliation/:mutationId/approve"',
    );
    expect(bankReconciliationSource).toContain(
      'router.get("/bank-reconciliation/mutations"',
    );
    expect(bankReconciliationSource).toContain(
      'router.get("/bank-reconciliation/summary"',
    );
    expect(bankReconciliationSource).toContain(
      'router.get("/bank-reconciliation/qris-candidates"',
    );
    expect(bankReconciliationSource).toContain(
      'router.post("/bank-reconciliation/qris-candidates/generate"',
    );
    expect(bankReconciliationSource).toContain(
      'router.post("/bank-reconciliation/qris-candidates/:candidateId/approve"',
    );
    expect(bankReconciliationSource).toContain("canonical_qris_settlement");
    expect(bankReconciliationSource).not.toContain("qris_mutation_batch_candidates");
    expect(bankReconciliationSource).toContain("LEGACY_QRIS_GENERATOR_REMOVED");
    expect(bankReconciliationSource).toContain("LEGACY_QRIS_APPROVAL_REMOVED");
    expect(bankReconciliationSource).toContain("await client.query(\"begin\")");
    expect(bankReconciliationSource).toContain("await client.query(\"commit\")");
    expect(bankReconciliationSource).toContain("source = 'bank_reconciliation'");
    expect(bankReconciliationSource).toContain("bank_reconciliation_audit");
    expect(bankReconciliationSource).not.toContain("requestUpstream");
  });
});
