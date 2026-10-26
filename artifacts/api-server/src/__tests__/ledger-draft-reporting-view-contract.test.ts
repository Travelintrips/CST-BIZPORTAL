import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sql = readFileSync(
  resolve(process.cwd(), "../../scripts/sql/20261027_cst_ledger_report_exclude_draft.sql"),
  "utf8",
);

describe("CST ledger reporting projection", () => {
  it("excludes only CST draft journals from both reporting views", () => {
    expect(sql).toContain("CREATE OR REPLACE VIEW public.v_ledger_balance_view");
    expect(sql).toContain("CREATE OR REPLACE VIEW public.v_ledger_journal_view");
    expect(sql.match(/fle.company_id=1 AND EXISTS \(/g)).toHaveLength(2);
    expect(sql.match(/ae.status::text='draft'/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("keeps historical mirror entries immutable and honors view RLS", () => {
    expect(sql.match(/WITH \(security_invoker = true\)/g)).toHaveLength(2);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.fleet_ledger_entries/i);
    expect(sql).not.toMatch(/UPDATE\s+public\.fleet_ledger_entries/i);
    expect(sql).toContain("CST draft journals visible in reporting view");
  });
});
