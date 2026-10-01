import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)), "utf8");

describe("QRIS candidate settlement date contract", () => {
  it("normalizes expected settlement date from the canonical Sport Center payment projection", () => {
    expect(src).toContain("nullif(to_jsonb(sp)->>'expected_settlement_date','')::date");
    expect(src).toContain("p.expected_settlement_date::text as expected_settlement_date");
    expect(src).toContain("calendarDateValue(source.expected_settlement_date)");
    expect(src).not.toContain("sp.expected_settlement_date = $2::date");
  });
});


describe("standalone QRIS payment date update route", () => {
  it("owns the date edit locally instead of falling through to the standalone 404", () => {
    expect(src).toContain(
      'router.patch("/bank-reconciliation/qris-candidates/payments/:paymentId/date"',
    );
    expect(src).toContain("UPDATE sport_center.sport_payments".toLowerCase());
    expect(src.toLowerCase()).toContain("update sport_center.sport_payments");
    expect(src).toContain("for update of sp");
    expect(src).toContain("ACTIVE_SETTLEMENT_EXISTS");
    expect(src).toContain("requiresCorrectionWorkflow: journalPosted");
    expect(src).toContain("candidateRefreshPending: false");
  });

  it("keeps canonical source ownership and posted journal immutability", () => {
    const routeStart = src.indexOf(
      'router.patch("/bank-reconciliation/qris-candidates/payments/:paymentId/date"',
    );
    const routeEnd = src.indexOf(
      'router.get("/bank-reconciliation/qris-candidates"',
      routeStart,
    );
    const route = src.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(route).toContain("set paid_at = ($2::date::text || ' 00:00:00+07:00')::timestamptz");
    expect(route).toContain("expected_settlement_date::text as expected_settlement_date");
    expect(route).not.toContain("update public.sport_payments");
    expect(route).not.toContain("update public.accounting_entries");
  });
});
