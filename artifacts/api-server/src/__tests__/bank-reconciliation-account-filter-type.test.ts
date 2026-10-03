import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)),
  "utf8",
);

describe("bank reconciliation account filter typing", () => {
  it("casts the numeric reconciliation account parameter to text for bank_mutations", () => {
    expect(src).toContain(
      "bm.bank_account_id = ${addValue(requestedBankAccountId)}::text",
    );
  });
});
