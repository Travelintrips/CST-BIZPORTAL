import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  matchingStatusPollInterval,
  MATCHING_STATUS_POLL_INTERVAL_MS,
  shouldRefreshOnMatchingTerminal,
} from "../lib/bankReconciliationRefreshPolicy";

const source = readFileSync(
  resolve(process.cwd(), "src/pages/accounting/bank-reconciliation.tsx"),
  "utf8",
);

describe("bank reconciliation event-based refresh", () => {
  it("does not poll an idle, completed, or failed job", () => {
    expect(matchingStatusPollInterval(undefined, false)).toBe(false);
    expect(matchingStatusPollInterval({ running: false }, false)).toBe(false);
  });

  it("polls at 5 seconds only while queued or actively running", () => {
    expect(MATCHING_STATUS_POLL_INTERVAL_MS).toBe(5_000);
    expect(matchingStatusPollInterval({ running: false }, true)).toBe(5_000);
    expect(matchingStatusPollInterval({ running: true }, false)).toBe(5_000);
    expect(matchingStatusPollInterval({ running: true }, true)).toBe(5_000);
  });

  it("treats completed and failed as terminal events, not idle", () => {
    expect(shouldRefreshOnMatchingTerminal("completed", true, false)).toBe(true);
    expect(shouldRefreshOnMatchingTerminal("failed", true, false)).toBe(true);
    expect(shouldRefreshOnMatchingTerminal("completed", false, true)).toBe(true);
    expect(shouldRefreshOnMatchingTerminal("idle", false, true)).toBe(false);
    expect(shouldRefreshOnMatchingTerminal("running", true, false)).toBe(false);
    expect(shouldRefreshOnMatchingTerminal("completed", false, false)).toBe(false);
  });

  it("has just one polling query: the matching status endpoint", () => {
    expect(source.match(/refetchInterval:/g)?.length).toBe(1);
    expect(source).toContain('refetchInterval: query => matchingStatusPollInterval(');
    expect(source).toContain('/api/bank-reconciliation/run-matching/status');
    expect(source).not.toContain('refetchInterval: 120_000');
    expect(source).not.toContain("waitForMatchingCompletion");
  });

  it("refreshes data after completion and after approved actions", () => {
    expect(source).toContain('qc.invalidateQueries({ queryKey: ["bank-reconciliation"] })');
    expect(source).toContain('qc.invalidateQueries({ queryKey: ["bank-reconciliation-summary"] })');
    expect(source).toContain('qc.invalidateQueries({ queryKey: ["bank-reconciliation-ready-approval"] })');
    expect(source).toContain('qc.invalidateQueries({ queryKey: ["qris-candidate-audit"] })');
    expect(source).toContain('qc.invalidateQueries({ queryKey: ["qris-settlement-reset-history"] })');
    expect(source).toContain("if (result.queued)");
    expect(source).toContain("shouldRefreshOnMatchingTerminal");
  });

  it("retains load-on-entry and a manual full refresh", () => {
    expect(source.match(/refetchOnMount: "always"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('onClick={() => void invalidate()} title="Refresh"');
    expect(source).toContain("qrisCompanyId != null && (showQrisAuditList || showCanonicalSettlementQueue)");
  });
});
