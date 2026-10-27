import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const page = readFileSync(
  resolve(process.cwd(), "src/pages/accounting/bank-reconciliation.tsx"),
  "utf8",
);

describe("Bank Reconciliation read error recovery", () => {
  it("classifies expired/unauthorized, forbidden, server error and timeout", () => {
    expect(page).toContain("function describeBankReconReadError");
    expect(page).toContain('error.name === "TimeoutError"');
    expect(page).toContain("typed?.httpStatus === 401");
    expect(page).toContain("typed?.httpStatus === 403");
    expect(page).toContain("typed.httpStatus >= 500");
    expect(page).toContain("error.httpStatus = response.status");
  });

  it("uses shared bounded fetch for list, summary and approval readiness", () => {
    expect(page).toContain("async function fetchBankReconRead<T>");
    expect(page).toContain("signal: AbortSignal.timeout(12_000)");
    expect(page).toContain("fetchBankReconRead<{ mutations: BankMutation[]; total?: number }>");
    expect(page).toContain("fetchBankReconRead<{ summary: { status: string; count: string; total_amount: string }[] }>");
    expect(page).toContain("fetchBankReconRead<{ mutations: BankMutation[]; total: number }>");
  });

  it("recovers both primary list and summary on either error", () => {
    expect(page).toContain("error: summaryReadError");
    expect(page).toContain(") : summaryReadError ? (");
    expect(page).toContain("describeBankReconReadError(summaryReadError)");
    expect(page).toContain("describeBankReconReadError(error)");
    expect(page.match(/Coba Lagi Ringkasan & Mutasi/g)?.length).toBeGreaterThanOrEqual(2);
    expect(page.match(/onClick=\{\(\) => void invalidate\(\)\}/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("preserves event-based polling, and transaction mutations remain untouched", () => {
    expect(page.match(/refetchInterval:/g)?.length).toBe(1);
    expect(page).toContain("refetchInterval: query => matchingStatusPollInterval(");
    expect(page).toContain('qc.invalidateQueries({ queryKey: ["bank-reconciliation"] })');
    expect(page).toContain('qc.invalidateQueries({ queryKey: ["bank-reconciliation-summary"] })');
  });
});
