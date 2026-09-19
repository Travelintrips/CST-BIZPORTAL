import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)), "utf8");

describe("bank mutation date serialization", () => {
  it("reads mutation DATE columns as ISO text before matching and approval", () => {
    expect(src.match(/transaction_date::text as transaction_date/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src).toContain("function calendarDateValue(value: unknown): string | null");
    expect(src).toContain("const date = calendarDateValue(mutation.transaction_date)");
    expect(src).toContain("const txDate = calendarDateValue(mutation.transaction_date)");
    expect(src).not.toContain('String(mutation.transaction_date).split("T")[0]');
  });

  it("normalizes JavaScript Date strings before PostgreSQL date parameters", () => {
    expect(src).toContain('timeZone: "Asia/Jakarta"');
    expect(src).toContain('"INVALID_TRANSACTION_DATE"');
    expect(src).toContain("const txDate = calendarDateValue(mutation.transaction_date)");
  });
});
