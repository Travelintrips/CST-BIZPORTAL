import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)), "utf8");

describe("QRIS candidate settlement date contract", () => {
  it("normalizes expected settlement date from the canonical Sport Center payment projection", () => {
    expect(src).toContain("nullif(to_jsonb(sp)->>'expected_settlement_date','')::date");
    expect(src).toContain("p.expected_settlement_date::text as expected_settlement_date");
    expect(src).toContain("calendarDateValue(source.expected_settlement_date)");
    expect(src).not.toContain("sp.expected_settlement_date = $2::date");
  });
});
