import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const api = readFileSync(fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)), "utf8");

describe("bank mutation possible duplicate posting guard", () => {
  it("checks a different posted bank mutation with identical source fields before posting", () => {
    expect(api).toContain("BANK_MUTATION_POSSIBLE_DUPLICATE_POSTED");
    expect(api).toContain("other.id <> current_mutation.id");
    expect(api).toContain("other.transaction_date = current_mutation.transaction_date");
    expect(api).toContain("other.bank_account_id = current_mutation.bank_account_id");
    expect(api).toContain("other.direction = current_mutation.direction");
    expect(api).toContain("other.amount = current_mutation.amount");
    expect(api).toContain("posted_entry.status = 'posted'");
    expect(api).toContain("pg_advisory_xact_lock");
  });
});
