import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const api = readFileSync(
  fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)),
  "utf8",
);

describe("bank reconciliation internal transfer contract", () => {
  it("creates a canonical cross-account candidate from a posted source mutation", () => {
    expect(api).toContain('candidateType: "internal_transfer"');
    expect(api).toContain('return "public.bank_mutations"');
    expect(api).toContain("source.direction = 'OUT'");
    expect(api).toContain("source.status = 'posted'");
    expect(api).toContain("source.reconciliation_status = 'reconciled'");
    expect(api).toContain("target_line.account_id = target_account.coa_id");
    expect(api).toContain("source_line.account_id = source_account.coa_id");
  });

  it("only accepts internal-transfer candidates backed by a posted bank mutation", () => {
    expect(api).toContain('candidateType === "internal_transfer"');
    expect(api).toContain('candidateSource !== "public.bank_mutations"');
    expect(api).toContain("INTERNAL_TRANSFER_SOURCE_INVALID");
    expect(api).toContain("INTERNAL_TRANSFER_SOURCE_ALREADY_LINKED");
  });

  it("reuses the existing posted source journal instead of creating a duplicate", () => {
    expect(api).toContain("resolvePostedInternalTransferJournal(");
    expect(api).toContain("INTERNAL_TRANSFER_JOURNAL_MISMATCH");
    expect(api).toContain("finalizeSourceJournalReuse(");
    expect(api).toContain("INTERNAL_TRANSFER_JOURNAL_REUSED");
    expect(api).toContain("INTERNAL_TRANSFER_PAIRED");
    expect(api).toContain('contract: "internal-transfer-journal-reuse-v1"');
  });

  it("links both bank mutations to each other after approval", () => {
    expect(api).toContain("linked_transaction_type = 'internal_transfer'");
    expect(api).toContain("linked_transaction_id = $2");
    expect(api).toContain("internal_transfer_source_mutation_id");
  });
});
