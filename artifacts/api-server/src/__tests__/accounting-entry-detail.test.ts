import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const route = readFileSync(
  fileURLToPath(new URL("../routes/accounting.ts", import.meta.url)),
  "utf8",
);

describe("Accounting journal entry detail contract", () => {
  it("exposes a company-scoped detail endpoint before the collection route", () => {
    const detailRoute = 'router.get("/accounting/entries/:id"';
    const collectionRoute = 'router.get("/accounting/entries"';

    expect(route).toContain(detailRoute);
    expect(route.indexOf(detailRoute)).toBeLessThan(route.indexOf(collectionRoute));
    expect(route).toContain("requestedCompanyId(req)");
    expect(route).toContain("and ($2::int is null or company_id = $2)");
  });

  it("returns journal header totals and canonical journal lines", () => {
    expect(route).toContain("from public.accounting_entries");
    expect(route).toContain("from public.accounting_entry_lines l");
    expect(route).toContain("left join public.chart_of_accounts a");
    expect(route).toContain("totalDebit: numberValue(header.total_debit)");
    expect(route).toContain("totalCredit: numberValue(header.total_credit)");
    expect(route).toContain("lines: lines.rows.map");
  });
});