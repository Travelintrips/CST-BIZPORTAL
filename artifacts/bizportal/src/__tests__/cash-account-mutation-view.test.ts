import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(
  resolve(process.cwd(), "src/pages/cash-bank/mutations.tsx"),
  "utf8",
);

describe("cash account mutation view", () => {
  it("requests the selected account together with the active company and date filters", () => {
    expect(pageSource).toContain('companyId: String(activeCompanyId)');
    expect(pageSource).toContain('params.append("account_id", accountId)');
    expect(pageSource).toContain('if (from) params.append("from", from);');
    expect(pageSource).toContain('if (to) params.append("to", to);');
    expect(pageSource).toContain('/cash-bank/mutations?');
  });

  it("maps debit to Masuk and credit to Keluar consistently in totals and rows", () => {
    expect(pageSource).toContain('const totalDebit = mutations.reduce');
    expect(pageSource).toContain('const totalCredit = mutations.reduce');
    expect(pageSource).toContain('Total Debit (Masuk)');
    expect(pageSource).toContain('Total Kredit (Keluar)');
    expect(pageSource).toContain('"Debit", "Kredit"');
  });

  it("keeps the mutation view read-only and sourced from posted cash-bank mutations", () => {
    expect(pageSource).toContain("Riwayat seluruh transaksi per rekening");
    expect(pageSource).not.toContain("Post ke Accounting");
    expect(pageSource).not.toContain("draft transfer");
  });
});
