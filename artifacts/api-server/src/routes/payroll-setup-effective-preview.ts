/**
 * DEV-only read-only projection of effective salary and manual deductions
 * into a draft payroll period. No payroll_items, GL, cash-advance or payment writes.
 * Amounts are parsed and summed as bigint cents; never calculate tax/BPJS rates.
 */
export type EffectiveSalaryRow = {
  employeeId: number | string;
  firstName: string;
  lastName: string;
  baseSalary: string | null;
  allowance: string | null;
  salaryEffectiveFrom: string | null;
};
export type EffectiveDeductionRow = {
  employeeId: number | string;
  code: string;
  amount: string;
  effectiveFrom: string;
  notes?: string | null;
  sourceType?: "verified_auto_reservation";
};
export const deductionCodes = [
  "bpjs_jht_employee", "bpjs_kes_employee", "pph21",
  "other_deductions", "kasbon_deduction",
] as const;
type DeductionCode = typeof deductionCodes[number];
const allowedCodes = new Set<string>(deductionCodes);

function safeId(raw: number | string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("INVALID_PAYROLL_EMPLOYEE_ID");
  return parsed;
}
function cents(raw: string): bigint {
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/.exec(raw);
  if (!m) throw new Error("INVALID_PAYROLL_CONFIG_AMOUNT");
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
}
function amount(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}
export function periodEnd(year: number, month: number): string {
  if (!Number.isInteger(month) || month < 1 || month > 12 ||
      !Number.isInteger(year) || year < 2020 || year > 2100)
    throw new Error("INVALID_PAYROLL_PERIOD");
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
export function buildEffectiveSetupPreview(
  employees: EffectiveSalaryRow[],
  deductions: EffectiveDeductionRow[],
  year: number,
  month: number,
) {
  const effectiveThrough = periodEnd(year, month);
  const grouped = new Map<number, Map<DeductionCode, bigint>>();
  const kasbonSourceMissing = new Set<number>();
  for (const d of deductions) {
    const id = safeId(d.employeeId);
    if (!allowedCodes.has(d.code) || d.effectiveFrom > effectiveThrough)
      throw new Error("INVALID_PAYROLL_DEDUCTION_SOURCE");
    const byCode = grouped.get(id) ?? new Map<DeductionCode, bigint>();
    if (byCode.has(d.code as DeductionCode)) throw new Error("DUPLICATE_EFFECTIVE_DEDUCTION");
    const value = cents(d.amount);
    if (d.code === "kasbon_deduction" && value > 0n &&
        d.sourceType !== "verified_auto_reservation") {
      // A manual note alone is not proof of an outstanding approved loan.
      // Positive kasbon must be produced by the verified Full/Installment reservation path.
      kasbonSourceMissing.add(id);
    }
    byCode.set(d.code as DeductionCode, value);
    grouped.set(id, byCode);
  }
  let grossTotal = 0n, deductionTotal = 0n, netTotal = 0n, missingCount = 0, invalidCount = 0, missingDeductionConfigCount = 0;
  const seen = new Set<number>();
  const rows = employees.map(e => {
    const employeeId = safeId(e.employeeId);
    if (seen.has(employeeId)) throw new Error("DUPLICATE_EMPLOYEE");
    seen.add(employeeId);
    const codes = grouped.get(employeeId) ?? new Map<DeductionCode, bigint>();
    const missingSalary = e.baseSalary == null || e.allowance == null || e.salaryEffectiveFrom == null;
    if (e.salaryEffectiveFrom && e.salaryEffectiveFrom > effectiveThrough)
      throw new Error("FUTURE_SALARY_CONFIGURATION");
    const base = missingSalary ? 0n : cents(e.baseSalary!);
    const allowance = missingSalary ? 0n : cents(e.allowance!);
    const gross = base + allowance;
    // An absent deduction is UNKNOWN, not an approved Rp0.
    // Explicit 0.00 records are allowed, but must be configured for every code.
    const missingDeductionCodes = deductionCodes.filter(code => !codes.has(code));
    const deductionsComplete = missingDeductionCodes.length === 0;
    if (!deductionsComplete) missingDeductionConfigCount++;
    const deductionMap = Object.fromEntries(
      deductionCodes.map(code => [code, codes.get(code) ?? null]),
    ) as Record<DeductionCode, bigint | null>;
    const deduction = deductionsComplete
      ? [...codes.values()].reduce((a, b) => a + b, 0n)
      : null;
    const net = deduction === null ? null : gross - deduction;
    const issues: string[] = [];
    if (missingSalary) { missingCount++; issues.push("STRUKTUR_GAJI_BELUM_ADA"); }
    if (!deductionsComplete) issues.push("POTONGAN_BELUM_DIKONFIRMASI");
    if (kasbonSourceMissing.has(employeeId)) issues.push("KASBON_BELUM_DIRENCANAKAN_OTOMATIS");
    if (!missingSalary && base === 0n) issues.push("TOTAL_SALARY_NOL");
    if (!missingSalary && net !== null && net < 0n) issues.push("POTONGAN_MELEBIHI_GAJI");
    if (issues.some(x => x !== "STRUKTUR_GAJI_BELUM_ADA" && x !== "POTONGAN_BELUM_DIKONFIRMASI")) invalidCount++;
    if (!missingSalary && deduction !== null && net !== null && net >= 0n &&
        base > 0n && !kasbonSourceMissing.has(employeeId)) {
      grossTotal += gross;
      deductionTotal += deduction;
      netTotal += net;
    }
    return {
      employeeId, employeeName: `${e.firstName} ${e.lastName}`.trim(),
      salaryEffectiveFrom: e.salaryEffectiveFrom,
      hasSalaryConfiguration: !missingSalary,
      deductionsConfigured: deductionsComplete,
      kasbonSourceRecorded: !kasbonSourceMissing.has(employeeId),
      missingDeductionCodes,
      baseSalary: missingSalary ? null : amount(base),
      allowance: missingSalary ? null : amount(allowance),
      gross: missingSalary ? null : amount(gross),
      deductions: Object.fromEntries(
        deductionCodes.map(code => [code, deductionMap[code] === null ? null : amount(deductionMap[code]!)]),
      ) as Record<DeductionCode, string | null>,
      totalDeductions: missingSalary || deduction === null ? null : amount(deduction),
      net: missingSalary || net === null || net < 0n || kasbonSourceMissing.has(employeeId) ? null : amount(net),
      issues,
    };
  });
  if ([...grouped.keys()].some(id => !seen.has(id))) throw new Error("ORPHAN_DEDUCTION_SOURCE");
  return {
    effectiveThrough,
    employeeCount: rows.length,
    configuredCount: rows.length - missingCount,
    missingSalaryCount: missingCount,
    missingDeductionConfigCount,
    invalidCount,
    canMaterialize: false as const,
    readyForPayment: false as const,
    persisted: false as const,
    automaticallyCalculatedTax: false as const,
    gross: amount(grossTotal),
    deductions: amount(deductionTotal),
    net: amount(netTotal),
    rows,
    note: "Pratinjau baca-saja. Total Salary + Uang Makan/Tunjangan Lain = gaji kotor. Potongan yang tidak dikonfigurasi ditampilkan kosong (bukan Rp0). BPJS/PPh21 diinput manual. Kasbon positif wajib berasal dari rencana Penuh/Cicilan dan reservasi terverifikasi; tidak mengurangi saldo sebelum settlement sah.",
  };
}
