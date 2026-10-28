import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const page = readFileSync(
  resolve(process.cwd(), "src/pages/accounting/bank-reconciliation.tsx"),
  "utf8",
);

describe("Bank reconciliation defaults to unfinished work", () => {
  it("starts on the server-side attention queue without preloading completed cards", () => {
    expect(page).toContain('const [filterStatus,   setFilterStatus]   = useState("attention")');
    expect(page).toContain('params.set("status", filterStatus)');
    expect(page).toContain('const statusFilteredMutations = (filterStatus === "all" || filterStatus === "attention")');
    expect(page).toContain('compact: "1"');
    expect(page).toContain('const PAGE_SIZE = 20');
  });

  it("keeps completed and all historical transactions explicitly accessible", () => {
    expect(page).toContain('{ label: "Perlu Ditangani",   status: "attention" }');
    expect(page).toContain('{ label: "Semua Mutasi",       status: "all" }');
    expect(page).toContain('{ label: "Selesai",            status: "completed" }');
    expect(page).toContain('Lihat seluruh riwayat');
    expect(page).toContain('setFilterStatus("all"); setPage(0);');
  });

  it("resets to the open queue and preserves bank account isolation", () => {
    const body = page.slice(
      page.indexOf("  const resetFilters = () => {"),
      page.indexOf("  const responseMutations =", page.indexOf("  const resetFilters = () => {")),
    );
    expect(body).toContain('setFilterStatus("attention")');
    expect(body).not.toContain('setFilterBankAccountId("all")');
    expect(page).toContain('onStatus(isActive ? "attention" : f.status)');
    expect(page).toContain('onFilter(activeFilter === key ? "attention" : key)');
  });

  it("reuses recent compact transaction/summary cache but invalidates on actions", () => {
    expect(page.match(/staleTime: 60_000,\n    refetchOnMount: true/g)?.length).toBeGreaterThanOrEqual(3);
    expect(page).toContain('qc.invalidateQueries({ queryKey: ["bank-reconciliation"] })');
    expect(page).toContain('qc.invalidateQueries({ queryKey: ["bank-reconciliation-summary"] })');
    expect(page).toContain('qc.invalidateQueries({ queryKey: ["bank-reconciliation-ready-approval"] })');
    expect(page.match(/refetchInterval:/g)?.length).toBe(1);
  });
});
