import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/routes/bank-reconciliation.ts"), "utf8");

describe("bank-reconciliation journal lifecycle metadata", () => {
  it("marks every journal created by canonical approval and vendor components as DRAFT, never POSTED", () => {
    expect(source.match(/'draft', 'DRAFT', 'bank_reconciliation'/g)).toHaveLength(2);
    expect(source).toContain("'draft','DRAFT','bank_reconciliation'");
    expect(source).not.toContain("'draft', 'bank_reconciliation', $6");
    expect(source).not.toContain("'draft','bank_reconciliation',$6");
  });
  it("synchronizes entry_status with the canonical posting transition", () => {
    expect(source).toContain("set status='posted',entry_status='POSTED',posted_at=coalesce(posted_at,now())");
  });
});