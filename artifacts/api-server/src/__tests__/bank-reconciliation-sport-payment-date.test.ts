import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("bank reconciliation Sport Center candidate date contract", () => {
  const routeSource = fs.readFileSync(
    path.resolve(process.cwd(), "src/routes/bank-reconciliation.ts"),
    "utf8",
  );

  it("keeps ordinary bank-transfer payments eligible on the same Jakarta calendar date", () => {
    expect(routeSource).toContain(
      "(coalesce(sp.paid_at, sp.created_at) at time zone 'Asia/Jakarta')::date = $3::date",
    );
    expect(routeSource).toContain("not like '%qris%'");
  });

  it("applies the H+1 settlement-date path only to QRIS payments", () => {
    expect(routeSource).toContain("like '%qris%'");
    expect(routeSource).toContain(
      "((coalesce(sp.paid_at, sp.created_at) at time zone 'Asia/Jakarta')::date + 1)",
    );
  });

  it("projects paid_date in the operational timezone used by matching", () => {
    expect(routeSource).toContain(
      "(coalesce(sp.paid_at, sp.created_at) at time zone 'Asia/Jakarta')::date::text as paid_date",
    );
  });
});
