import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";

const source=readFileSync(new URL("../routes/bank-reconciliation.ts",import.meta.url),"utf8");
const start=source.indexOf("async function runIssue292CorrectionWithCanonicalApproval(");
const end=source.indexOf("async function approveBankMutation(",start);
const bridge=source.slice(start,end);

describe("Issue #292 existing canonical approval transaction bridge",()=>{
  it("is internal and reuses both real canonical bank link approvals in one transaction",()=>{
    expect(start).toBeGreaterThan(0);
    expect(bridge).toContain('await client.query("BEGIN")');
    expect(bridge).toContain('await client.query("COMMIT")');
    expect(bridge).toContain('await client.query("ROLLBACK")');
    expect(bridge).toContain("runAtomicCanonicalSettlementCorrection(");
    expect(bridge).toContain("rebuildIssue292WithOwnerFunctions(");
    expect(bridge).toContain("approveCanonicalSettlementLink(");
    expect(bridge).toContain("client, 434462, batches.nov4BatchId");
    expect(bridge).toContain("client, 434464, batches.nov5BatchId");
    expect(bridge).not.toContain("router.post(");
    expect(bridge).not.toContain("create_payment_settlement_batch(");
    expect(bridge).not.toContain("UPDATE public.bank_mutations");
  });
  it("requires trusted actor scope and uses the same client for SQL executions",()=>{
    expect(bridge).toContain("actor.companyId !== 1");
    expect(bridge).toContain("dialect.sqlToQuery(statement)");
    expect(bridge).toContain("return client.query(compiled.sql, compiled.params)");
    expect(bridge).toContain("SELECT current_user AS db_principal");
    expect(bridge).toContain('principal.rows[0]?.db_principal !== "sport_center_app"');
    expect(bridge).toContain("ISSUE292_FINANCE_PRINCIPAL_UNVERIFIED");
    expect(bridge.indexOf("ISSUE292_FINANCE_PRINCIPAL_UNVERIFIED"))
      .toBeLessThan(bridge.indexOf("const value = await callback(tx)"));
    expect(bridge).toContain("await assertIssue292OwnerRuleParity(client)");
    expect(bridge).toContain("actor: actor.email");
    expect(bridge).toContain("reason:");
    expect(bridge).toContain('if (nov4.status !== "approved" || nov5.status !== "approved")');
  });
});
