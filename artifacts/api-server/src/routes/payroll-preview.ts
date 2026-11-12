/**
 * Read-only payroll preview based entirely on persisted item values.
 * All amounts use integer cents, not binary-floating-point arithmetic.
 * No automatic BPJS, PPh21, kasbon, posting, or disbursement.
 */
export type PayrollPreviewItem = {
  id: number;
  employeeId: number;
  baseSalary: string;
  allowance: string;
  grossSalary: string;
  bpjsJhtEmployee: string;
  bpjsKesEmployee: string;
  pph21: string;
  otherDeductions: string;
  kasbonDeduction: string;
  totalDeductions: string;
  netSalary: string;
};

function cents(raw: string): bigint {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/.exec(raw);
  if (!match) throw new Error("INVALID_PAYROLL_AMOUNT");
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}
function amount(raw: bigint): string {
  if (raw < 0n) throw new Error("NEGATIVE_PAYROLL_AMOUNT");
  return `${raw / 100n}.${(raw % 100n).toString().padStart(2, "0")}`;
}

export function buildPayrollPreview(items: PayrollPreviewItem[]) {
  let grossSum = 0n;
  let deductionSum = 0n;
  let netSum = 0n;
  const mismatchedItemIds: number[] = [];
  for (const item of items) {
    const gross = cents(item.baseSalary) + cents(item.allowance);
    const deductions =
      cents(item.bpjsJhtEmployee) + cents(item.bpjsKesEmployee) +
      cents(item.pph21) + cents(item.otherDeductions) + cents(item.kasbonDeduction);
    const net = gross - deductions;
    if (net < 0n) throw new Error("DEDUCTIONS_EXCEED_GROSS");
    if (
      cents(item.grossSalary) !== gross ||
      cents(item.totalDeductions) !== deductions ||
      cents(item.netSalary) !== net
    ) mismatchedItemIds.push(item.id);
    grossSum += gross;
    deductionSum += deductions;
    netSum += net;
  }
  return {
    itemCount: items.length,
    gross: amount(grossSum),
    deductions: amount(deductionSum),
    net: amount(netSum),
    mismatchedItemIds,
    readyForPayment: false as const,
    automaticallyCalculated: false as const,
    note: "Gaji kotor = Total Salary + Uang Makan/Tunjangan Lain. Pratinjau menjumlahkan item tersimpan; BPJS/PPh21 manual dan kasbon berasal dari reservasi Penuh/Cicilan terverifikasi.",
  };
}
