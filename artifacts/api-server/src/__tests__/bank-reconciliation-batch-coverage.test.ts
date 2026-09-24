import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)),
  "utf8",
);

describe("bank reconciliation matching batch coverage", () => {
  it("does not stop after only the newest twenty non-final mutations", () => {
    const start = source.indexOf('router.post("/bank-reconciliation/run-matching"');
    const end = source.indexOf("type SourceReceiptJournal", start);
    const body = source.slice(start, end);
    expect(body).toContain("limit 200");
    expect(body).not.toContain("limit 20");
  });
});
