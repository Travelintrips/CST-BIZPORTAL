import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/routes/bank-reconciliation.ts"),
  "utf8",
);

describe("manual reconciliation candidate persistence", () => {
  it("does not delete operator-confirmed manual candidates when AI matching is rerun", () => {
    expect(source).toContain("and coalesce(is_manual, false) = false");
    expect(source).toContain("status not in ('approved', 'posted')");
  });
});
