import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const index = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
const route = readFileSync(resolve(process.cwd(), "src/routes/bank-reconciliation.ts"), "utf8");

describe("Rule AI must not auto-approve merely because classification matched", () => {
  it("gates 100% confidence and special Kas Besar SC auto post by a separately authorized rule ID", () => {
    expect(route).toContain("const autoPostEligible = !requiresRecoveredSourceReview");
    expect(route).toContain("&& isReconRuleAutoApprovalAllowed(matchedRule.id)");
    expect(route).toContain("&& (confidence === 100 || kasScApprovedRuleAutoPost)");
  });
  it("gates the legacy backfill both in the scheduler and the callable worker", () => {
    expect(index).toContain("const kasScRuleBackfillTimer = canRunLegacyKasScRuleBackfill()");
    expect(index).toContain("if (kasScRuleBackfillTimer) clearInterval(kasScRuleBackfillTimer)");
    expect(route).toContain("if (!canRunLegacyKasScRuleBackfill())");
    expect(route).toContain("if (!isReconRuleAutoApprovalAllowed(row.rule_id)) continue;");
  });
});