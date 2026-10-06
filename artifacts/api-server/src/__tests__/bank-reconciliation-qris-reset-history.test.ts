import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(process.cwd(), "src/routes/bank-reconciliation.ts"),
  "utf8",
);

describe("QRIS reset history endpoint", () => {
  it("uses the reconciliation auth/company scope and reads only reset-to-unsettled audit rows", () => {
    const start = source.indexOf(
      'router.get("/bank-reconciliation/qris-reset-history"',
    );
    const end = source.indexOf(
      'router.get("/bank-reconciliation/run-matching/status"',
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const route = source.slice(start, end);

    expect(route).toContain("getApprovalActor(req)");
    expect(route).toContain("actor.companyId ?? requestedCompanyId");
    expect(route).toContain("from public.erp_audit_logs al");
    expect(route).toContain("al.company_id = $1");
    expect(route).toContain("status_change");
    expect(route).toContain("sport-payment-%");
    expect(route).toContain("al.new_data->>'settlement_status'");
    expect(route).toContain("= 'unsettled'");
    expect(route).toContain("al.old_data->>'settlement_status'");
    expect(route).toContain("<> 'unsettled'");
  });
});
