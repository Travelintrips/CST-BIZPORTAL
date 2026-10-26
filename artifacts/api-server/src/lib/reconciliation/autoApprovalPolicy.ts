/**
 * A Rule AI being active is permission to classify candidates, NOT permission
 * to approve, create payment journals or post to the ledger.
 *
 * Legacy data has no per-rule automatic-approval column. Until the UI offers
 * a separately authorized per-rule setting, auto-approval requires BOTH an
 * explicit deployment opt-in and a positive allowlist of rule IDs.
 * Absent flags default to MANUAL APPROVAL.
 */
type AutoApprovalEnvironment = Record<string, string | undefined>;

export function isReconRuleAutoApprovalAllowed(
  ruleId: number,
  env: AutoApprovalEnvironment = process.env,
): boolean {
  if (!Number.isSafeInteger(ruleId) || ruleId <= 0) return false;
  if (String(env["RECON_RULE_AI_AUTO_APPROVAL_ENABLED"] ?? "").trim().toLowerCase() !== "true") {
    return false;
  }
  const allowlistedIds = String(env["RECON_RULE_AI_AUTO_APPROVED_RULE_IDS"] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^[1-9]\d*$/.test(id))
    .map(Number);
  return allowlistedIds.includes(ruleId);
}

export function canRunLegacyKasScRuleBackfill(
  env: AutoApprovalEnvironment = process.env,
): boolean {
  // Do not schedule legacy backfill just because a rule is enabled.
  // It must have a SECOND explicit opt-in in addition to the rule allowlist.
  if (String(env["RECON_KAS_SC_LEGACY_BACKFILL_ENABLED"] ?? "").trim().toLowerCase() !== "true") {
    return false;
  }
  return String(env["RECON_RULE_AI_AUTO_APPROVED_RULE_IDS"] ?? "")
    .split(",")
    .some((id) => /^[1-9]\d*$/.test(id.trim()) && isReconRuleAutoApprovalAllowed(Number(id.trim()), env));
}
