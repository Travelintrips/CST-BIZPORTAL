import { describe, expect, it } from "vitest";
import { buildPayrollPreview, type PayrollPreviewItem } from "./payroll-preview";

const item = (overrides: Partial<PayrollPreviewItem> = {}): PayrollPreviewItem => ({
  id: 11, employeeId: 101,
  baseSalary: "5000000.00", allowance: "250000.00",
  grossSalary: "5250000.00",
  bpjsJhtEmployee: "100000.00", bpjsKesEmployee: "50000.00",
  pph21: "25000.00", otherDeductions: "20000.00",
  kasbonDeduction: "100000.00", totalDeductions: "295000.00",
  netSalary: "4955000.00",
  ...overrides,
});

describe("read-only payroll preview", () => {
  it("returns exact persisted totals without calculating rates", () => {
    const preview = buildPayrollPreview([item()]);
    expect(preview).toMatchObject({
      itemCount: 1, gross: "5250000.00", deductions: "295000.00",
      net: "4955000.00", mismatchedItemIds: [],
      readyForPayment: false, automaticallyCalculated: false,
    });
  });
  it("returns explicit zero totals for an empty Draft", () => {
    expect(buildPayrollPreview([])).toMatchObject({
      itemCount: 0, gross: "0.00", deductions: "0.00", net: "0.00",
      mismatchedItemIds: [],
    });
  });
  it("uses exact cents for small decimals", () => {
    const row = item({ baseSalary: "0.10", allowance: "0.20", grossSalary: "0.30",
      bpjsJhtEmployee: "0.01", bpjsKesEmployee: "0.02", pph21: "0.03",
      otherDeductions: "0.04", kasbonDeduction: "0.05",
      totalDeductions: "0.15", netSalary: "0.15" });
    expect(buildPayrollPreview([row])).toMatchObject({
      gross: "0.30", deductions: "0.15", net: "0.15", mismatchedItemIds: [],
    });
  });
  it("flags inaccurate stored amounts instead of silently rewriting them", () => {
    expect(buildPayrollPreview([item({ netSalary: "4954999.99" })]).mismatchedItemIds).toEqual([11]);
  });
  it("rejects malformed and negative amounts", () => {
    for (const bad of ["-1", "1e3", "NaN", "0.001", "1,000.00", ""]) {
      expect(() => buildPayrollPreview([item({ allowance: bad })])).toThrow("INVALID_PAYROLL_AMOUNT");
    }
  });
  it("refuses deductions greater than gross", () => {
    expect(() => buildPayrollPreview([item({ otherDeductions: "6000000.00" })]))
      .toThrow("DEDUCTIONS_EXCEED_GROSS");
  });
});
