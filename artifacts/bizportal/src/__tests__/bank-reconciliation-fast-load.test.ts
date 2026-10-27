import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(process.cwd(), "src/pages/accounting/bank-reconciliation.tsx"),
  "utf8",
);

describe("bank reconciliation fast initial load and safe filters", () => {
  it("debounces search without delaying user input or fetching every keypress", () => {
    expect(source).toContain("const [debouncedSearch, setDebouncedSearch] = useState(filterSearch)");
    expect(source).toContain("window.setTimeout(() => setDebouncedSearch(filterSearch), 400)");
    expect(source).toContain("window.clearTimeout(timeout)");
    expect(source).toContain('if (debouncedSearch) params.set("search", debouncedSearch)');
    expect(source).not.toContain('if (filterSearch) params.set("search", filterSearch)');
    expect(source).toContain('setFilterSearch(""); setDebouncedSearch(""); setPage(0)');
  });

  it("keeps account filtering but loads account choices on interaction", () => {
    expect(source).toContain('onOpenChange={open => { if (open) setLoadBankAccountOptions(true); }}');
    expect(source).toContain("enabled: qrisCompanyId != null && loadBankAccountOptions");
    expect(source).toContain('value={filterBankAccountId}');
    expect(source).toContain('onValueChange={value => {');
    expect(source).toContain("Memuat akun bank...");
  });

  it("loads optional Google Sheet config when user opens configuration", () => {
    expect(source).toContain("(expanded || showForm)");
    expect(source).toContain('"Buka untuk memuat"');
    expect(source).toContain("Memuat koneksi Google Sheet...");
  });

  it("bounds initial reads and does not retry them indefinitely", () => {
    expect(source.match(/signal: AbortSignal\.timeout\(12_000\)/g)?.length).toBe(3);
    expect(source.match(/retry: false/g)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain("Permintaan daftar mutasi gagal atau terlalu lama");
    expect(source).toContain("readinessError");
  });

  it("loads primary list and summary before optional readiness details", () => {
    expect(source).toContain("!isLoading && !summaryLoading && Boolean(data) && Boolean(summary)");
    expect(source).toContain("Menghitung mutasi siap disetujui...");
    expect(source).toContain('queryKey: ["bank-reconciliation-ready-approval"');
    expect(source).toContain('queryKey: ["bank-reconciliation-summary"');
  });

  it("preserves protected actions, journal detail, and event-driven refresh", () => {
    expect(source).toContain("/api/bank-reconciliation/mutations/${mutation.id}");
    expect(source).toContain('qc.invalidateQueries({ queryKey: ["bank-reconciliation"] })');
    expect(source).toContain('qc.invalidateQueries({ queryKey: ["bank-reconciliation-summary"] })');
    expect(source).toContain('qc.invalidateQueries({ queryKey: ["bank-reconciliation-ready-approval"] })');
    expect(source).toContain('refetchInterval: query => matchingStatusPollInterval(');
    expect(source.match(/refetchInterval:/g)?.length).toBe(1);
  });
});
