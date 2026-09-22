import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const route = readFileSync(
  fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)),
  "utf8",
);

describe("draft journal unmatch FK ordering", () => {
  it("unlinks bank_mutations before deleting the referenced draft journal", () => {
    const routeStart = route.indexOf(
      'router.post("/bank-reconciliation/:mutationId/unmatch"',
    );
    expect(routeStart).toBeGreaterThanOrEqual(0);

    const unmatchRoute = route.slice(
      routeStart,
      route.indexOf("\nfunction parsePositiveInt", routeStart),
    );
    const unlinkIndex = unmatchRoute.indexOf("set journal_entry_id = null");
    const deleteIndex = unmatchRoute.indexOf(
      "delete from public.accounting_entries",
    );

    expect(unlinkIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(unlinkIndex);
    expect(unmatchRoute).toContain(
      "and journal_entry_id = $2",
    );
    expect(unmatchRoute).toContain(
      'error.code = "JOURNAL_CONCURRENT_CHANGE"',
    );
  });
});
