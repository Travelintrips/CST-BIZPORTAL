import { describe, expect, it } from "vitest";
import { buildEffectiveSetupPreview, periodEnd } from "./payroll-setup-effective-preview";

const salary = (employeeId: number | string, baseSalary: string | null, allowance: string | null = "0.00", salaryEffectiveFrom: string | null = "2026-11-01") =>
  ({ employeeId, firstName: "Uji", lastName: String(employeeId), baseSalary, allowance, salaryEffectiveFrom });
const d = (employeeId: number | string, code: string, amount: string, effectiveFrom = "2026-11-01", notes: string | null = null) =>
  ({ employeeId, code, amount, effectiveFrom, notes });

describe("DEV Payroll effective-dated setup projection", () => {
  it("uses exact cents, aggregates manual deductions, and never materializes", () => {
    const result = buildEffectiveSetupPreview([
      salary("21", "5000000.10", "500000.20"), salary(22, "6500000.00", "750000.00"),
    ], [
      d("21", "bpjs_jht_employee", "100000.10"),
      d("21", "bpjs_kes_employee", "50000.00"),
      d("21", "pph21", "75000.01"),
      d("21", "other_deductions", "0.00"),
      {...d("21", "kasbon_deduction", "200000.09", "2026-11-01", "Potongan kasbon otomatis BizPortal: #501"), sourceType:"verified_auto_reservation"},
      d(22, "pph21", "400000.00"),
      d(22, "bpjs_jht_employee", "0.00"),
      d(22, "bpjs_kes_employee", "0.00"),
      d(22, "other_deductions", "0.00"),
      d(22, "kasbon_deduction", "0.00"),
    ], 2026, 11);
    expect(result).toMatchObject({
      effectiveThrough: "2026-11-30", employeeCount: 2, configuredCount: 2,
      missingSalaryCount: 0, missingDeductionConfigCount: 0, invalidCount: 0, gross: "12750000.30",
      deductions: "825000.20", net: "11925000.10",
      persisted: false, canMaterialize: false, readyForPayment: false,
      automaticallyCalculatedTax: false,
    });
    expect(result.rows[0]).toMatchObject({ employeeId: 21, net: "5075000.10", salaryEffectiveFrom: "2026-11-01", issues: [] });
  });
  it("reports missing configuration rather than falling back to employees.salary or zeroing pay", () => {
    const result = buildEffectiveSetupPreview([salary(1, null, null, null)], [], 2026, 11);
    expect(result.missingSalaryCount).toBe(1);
    expect(result.rows[0]).toMatchObject({ hasSalaryConfiguration: false, baseSalary: null, net: null, issues: ["STRUKTUR_GAJI_BELUM_ADA", "POTONGAN_BELUM_DIKONFIRMASI"] });
    expect(result.canMaterialize).toBe(false);
  });
  it("keeps missing deductions UNKNOWN and makes salary unmaterializable even if gross is known", () => {
    const result = buildEffectiveSetupPreview([salary(17,"3000000.00","200000.00")],
      [d(17,"pph21","0.00")],2026,11);
    expect(result).toMatchObject({employeeCount:1,configuredCount:1,missingSalaryCount:0,
      missingDeductionConfigCount:1,invalidCount:0,gross:"0.00",net:"0.00",canMaterialize:false});
    expect(result.rows[0]).toMatchObject({
      deductionsConfigured:false,missingDeductionCodes:[
        "bpjs_jht_employee","bpjs_kes_employee","other_deductions","kasbon_deduction",
      ],totalDeductions:null,net:null,issues:["POTONGAN_BELUM_DIKONFIRMASI"],
    });
    expect(result.rows[0].deductions.pph21).toBe("0.00");
    expect(result.rows[0].deductions.bpjs_jht_employee).toBeNull();
  });
  it("blocks positive manual kasbon even with a note; only verified auto-plan marker is accepted", () => {
    const rows = [d(50,"bpjs_jht_employee","0.00"), d(50,"bpjs_kes_employee","0.00"),
      d(50,"pph21","0.00"), d(50,"other_deductions","0.00"),
      d(50,"kasbon_deduction","100000.25")];
    const blocked=buildEffectiveSetupPreview([salary(50,"5000000.00")],rows,2026,11);
    expect(blocked.invalidCount).toBe(1);
    expect(blocked.rows[0]).toMatchObject({kasbonSourceRecorded:false,net:null,
      issues:["KASBON_BELUM_DIRENCANAKAN_OTOMATIS"]});
    expect(blocked.gross).toBe("0.00");
    const documented=buildEffectiveSetupPreview([salary(50,"5000000.00")],
      rows.map(x=>x.code==="kasbon_deduction"?{...x,notes:"Nota internal HR-001"}:x),2026,11);
    expect(documented.invalidCount).toBe(1);
    expect(documented.rows[0]).toMatchObject({kasbonSourceRecorded:false,net:null,
      issues:["KASBON_BELUM_DIRENCANAKAN_OTOMATIS"]});
    const reserved=buildEffectiveSetupPreview([salary(50,"5000000.00")],
      rows.map(x=>x.code==="kasbon_deduction"?{...x,notes:"Potongan kasbon otomatis BizPortal: #501",sourceType:"verified_auto_reservation" as const}:x),2026,11);
    expect(reserved.invalidCount).toBe(0);
    expect(reserved.rows[0]).toMatchObject({kasbonSourceRecorded:true,
      totalDeductions:"100000.25",net:"4899999.75",issues:[]});
  });
  it("marks over-deduction and zero base salary unsafe", () => {
    const result = buildEffectiveSetupPreview([salary(1,"500.00"),salary(2,"0.00")],
      [d(1,"pph21","501.00"),
       d(1,"bpjs_jht_employee","0.00"),d(1,"bpjs_kes_employee","0.00"),
       d(1,"other_deductions","0.00"),d(1,"kasbon_deduction","0.00")],2026,11);
    expect(result.invalidCount).toBe(2);
    expect(result.rows[0].net).toBeNull();
    expect(result.rows[0].issues).toContain("POTONGAN_MELEBIHI_GAJI");
    expect(result.rows[1].issues).toContain("TOTAL_SALARY_NOL");
  });
  it("rejects duplicate effective deductions, malformed money and foreign source rows", () => {
    expect(() => buildEffectiveSetupPreview([salary(1,"100.00")],[d(1,"pph21","10.00"),d(1,"pph21","11.00")],2026,11))
      .toThrow("DUPLICATE_EFFECTIVE_DEDUCTION");
    expect(() => buildEffectiveSetupPreview([salary(1,"100.00")],[d(1,"pph21","NaN")],2026,11))
      .toThrow("INVALID_PAYROLL_CONFIG_AMOUNT");
    expect(() => buildEffectiveSetupPreview([salary(1,"100.00")],[d(2,"pph21","10.00")],2026,11))
      .toThrow("ORPHAN_DEDUCTION_SOURCE");
    expect(() => buildEffectiveSetupPreview([salary("9007199254740993","100.00")],[],2026,11))
      .toThrow("INVALID_PAYROLL_EMPLOYEE_ID");
  });
  it("checks calendar month cutoff and leap years", () => {
    expect(periodEnd(2028,2)).toBe("2028-02-29");
    expect(periodEnd(2026,2)).toBe("2026-02-28");
    expect(() => periodEnd(2026,13)).toThrow("INVALID_PAYROLL_PERIOD");
    expect(() => buildEffectiveSetupPreview([salary(1,"100.00","0.00","2026-12-01")],[],2026,11))
      .toThrow("FUTURE_SALARY_CONFIGURATION");
  });
});
