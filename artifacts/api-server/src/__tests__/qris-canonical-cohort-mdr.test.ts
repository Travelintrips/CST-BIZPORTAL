import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "../../scripts/sql/20261015_qris_recorded_payment_mdr_owner.sql"),
  "utf8",
);

type SettlementEvidence = { date: string; gross: number; recordedMdr: number; bankNet: number; feeCorrections: Array<[number, number]> };
const observed: SettlementEvidence[] = [
  { date: "2026-10-07", gross: 690000, recordedMdr: 4200, bankNet: 685800, feeCorrections: [] },
  { date: "2026-10-08", gross: 1110000, recordedMdr: 2100, bankNet: 1103700, feeCorrections: [[744, 2800], [751, 1400]] },
  { date: "2026-10-09", gross: 1370000, recordedMdr: 6300, bankNet: 1361250, feeCorrections: [[760, 2450]] },
];

describe("Mandiri QRIS October 7-9 settlement evidence", () => {
  it("protects the original canonical owner definition from drift", () => {
    expect(migration).toContain("92e78f9120966df50f9f53e381fc868a");
    expect(migration).toContain("CANONICAL_SETTLEMENT_OWNER_DRIFT");
    expect(migration).toContain("SET LOCAL lock_timeout = '10s'");
  });

  it("limits the recorded-MDR override to the audited company, bank and dates", () => {
    expect(migration).toContain("IF p_company_id = 1");
    expect(migration).toContain("lower(btrim(p_provider_code)) = 'mandiri_direct'");
    expect(migration).toContain("p_settlement_date BETWEEN DATE '2026-10-07' AND DATE '2026-10-09'");
    expect(migration).toContain("CANONICAL_SETTLEMENT_PROVIDER_RULE_DRIFT");
    expect(migration).toContain("v_effective_mdr_rate := v_recorded_mdr / v_gross");
    expect(migration).toContain("CANONICAL_SETTLEMENT_PARTIAL_MDR_EVIDENCE");
  });

  it("preserves zero-MDR records instead of charging 0.7 percent to all payments", () => {
    expect(observed[0].gross - observed[0].recordedMdr).toBe(observed[0].bankNet);
    expect(Math.round(observed[0].gross * 0.007)).toBe(4830);
    expect(observed[0].recordedMdr).toBe(4200);
  });

  it.each(observed)("requires source proof before the $date cohort can be approved", (day) => {
    const currentNet = day.gross - day.recordedMdr;
    const additionalMdr = day.feeCorrections.reduce((sum, [, amount]) => sum + amount, 0);
    expect(currentNet - day.bankNet).toBe(additionalMdr);
    expect(day.gross - day.recordedMdr - additionalMdr).toBe(day.bankNet);
  });

  it("does not contain unattended source-payment updates or approval writes", () => {
    expect(migration).not.toMatch(/UPDATE\s+sport_center\.sport_payments/i);
    expect(migration).not.toMatch(/UPDATE\s+public\.bank_mutations/i);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+public\.bank_reconciliation_matches/i);
  });
});
