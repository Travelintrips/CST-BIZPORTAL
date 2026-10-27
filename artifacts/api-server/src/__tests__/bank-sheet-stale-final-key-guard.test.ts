import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/lib/bank-sheet-sync.ts"), "utf8");

describe("finalized bank statement key collisions", () => {
  it("never reuses a finalized entry with a different amount and description", () => {
    expect(source).toContain("const finalizedKeyConflict");
    expect(source).toContain("foundByMutationKey.amount != null");
    expect(source).toContain("normalizeDescription(foundByMutationKey.description ??");
    expect(source).toContain("const resolvedKey = finalizedKeyConflict ? item.canonical : item.key");
    expect(source).toContain("const found = foundByCanonical ?? (finalizedKeyConflict ? undefined : foundByMutationKey)");
    expect(source).toContain("mutationStatuses.set(item.row.rowNumber, toSheetMetadata(mutation, resolvedKey))");
  });

  it("keeps posted economic rows immutable while emitting unmatched new rows", () => {
    expect(source).toContain("const canRefreshFromSheet");
    expect(source).toContain("found.journal_entry_id == null");
    expect(source).toContain("status, source, source_account");
    expect(source).toContain("'actual_bank_mutation', 'unmatched', 'google_sheet'");
  });
});
