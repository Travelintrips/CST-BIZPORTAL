import { describe, it, expect } from "vitest";
import { canRunLegacyKasScRuleBackfill, isReconRuleAutoApprovalAllowed } from "../lib/reconciliation/autoApprovalPolicy";

describe("Rule AI approval requires separately configured permission", () => {
  it("never treats an active or 100% confidence rule as consent to post", () => {
    expect(isReconRuleAutoApprovalAllowed(181, {})).toBe(false);
    expect(isReconRuleAutoApprovalAllowed(181, { RECON_RULE_AI_AUTO_APPROVAL_ENABLED: "true" })).toBe(false);
    expect(isReconRuleAutoApprovalAllowed(181, { RECON_RULE_AI_AUTO_APPROVED_RULE_IDS: "181" })).toBe(false);
  });
  it("only approves an explicitly allowlisted rule when enabled", () => {
    const env = { RECON_RULE_AI_AUTO_APPROVAL_ENABLED: "true", RECON_RULE_AI_AUTO_APPROVED_RULE_IDS: "98, 181" };
    expect(isReconRuleAutoApprovalAllowed(181, env)).toBe(true);
    expect(isReconRuleAutoApprovalAllowed(98, env)).toBe(true);
    expect(isReconRuleAutoApprovalAllowed(182, env)).toBe(false);
    expect(isReconRuleAutoApprovalAllowed(0, env)).toBe(false);
  });
  it("keeps legacy two-minute backfill disabled unless independently enabled", () => {
    const env = { RECON_RULE_AI_AUTO_APPROVAL_ENABLED: "true", RECON_RULE_AI_AUTO_APPROVED_RULE_IDS: "181" };
    expect(canRunLegacyKasScRuleBackfill(env)).toBe(false);
    expect(canRunLegacyKasScRuleBackfill({
      ...env, RECON_KAS_SC_LEGACY_BACKFILL_ENABLED: "true"
    })).toBe(true);
    expect(canRunLegacyKasScRuleBackfill({ RECON_KAS_SC_LEGACY_BACKFILL_ENABLED: "true" })).toBe(false);
  });
});
