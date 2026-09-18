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
    expect(bankReconciliationSource).toContain("await client.query(\"begin\")");
    expect(bankReconciliationSource).toContain("await client.query(\"commit\")");
    expect(bankReconciliationSource).toContain("source = 'bank_reconciliation'");
    expect(bankReconciliationSource).toContain("bank_reconciliation_audit");
    expect(bankReconciliationSource).not.toContain("requestUpstream");
  });
});
