import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const api = readFileSync(
  fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)),
  "utf8",
);
const ui = readFileSync(
  fileURLToPath(new URL("../../../bizportal/src/pages/accounting/bank-reconciliation.tsx", import.meta.url)),
  "utf8",
);

describe("bank reconciliation post contract", () => {
  it("exposes a mutation-scoped journal detail endpoint", () => {
    expect(api).toContain('router.get("/bank-reconciliation/:mutationId/journal-entry"');
    expect(api).toContain("source='bank_reconciliation'");
    expect(ui).toContain('/api/bank-reconciliation/${mutationId}/journal-entry');
  });

  it("routes manual posting through the canonical transactional service", () => {
    expect(api).toContain('router.post("/bank-reconciliation/:mutationId/post"');
    expect(api).toContain("postBankMutationCanonical(");
    expect(api).toContain("CANONICAL_SETTLEMENT_GENERIC_POST_BLOCKED");
    expect(ui).toContain('/api/bank-reconciliation/${mutId}/post');
  });

  it("does not label manual canonical posting as Rule AI", () => {
    expect(api).toContain('String(meta.review_code ?? "CANONICAL_POSTED")');
    expect(api).toContain("review_code: 'RULE_AI_AUTO_POSTED'");
  });
});
