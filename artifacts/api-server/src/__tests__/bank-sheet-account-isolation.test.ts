import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const routeSource = readFileSync(
  resolve(process.cwd(), "src/routes/bank-reconciliation.ts"),
  "utf8",
);
const syncSource = readFileSync(
  resolve(process.cwd(), "src/lib/bank-sheet-sync.ts"),
  "utf8",
);
const isolationSql = readFileSync(
  resolve(process.cwd(), "scripts/ensure-bank-sheet-account-isolation.sql"),
  "utf8",
);

describe("Google Sheet reconciliation account isolation", () => {
  it("allows the same spreadsheet to be reused only through a different tab", () => {
    expect(isolationSql).toContain(
      "bank_sheet_configs_company_sheet_tab_unique",
    );
    expect(isolationSql).toContain(
      "on public.bank_sheet_configs(company_id, sheet_id, tab_name)",
    );
  });

  it("binds each active sheet config to a company-owned reconciliation account", () => {
    expect(isolationSql).toContain("bank_sheet_configs_company_account_fkey");
    expect(isolationSql).toContain(
      "foreign key (company_id, bank_account_id)",
    );
    expect(isolationSql).toContain(
      "bank_sheet_configs_active_requires_scope_ck",
    );
    expect(isolationSql).toContain(
      "bank_sheet_configs_one_active_per_account",
    );
    expect(routeSource).toContain(
      "Tambahkan Akun Rekonsiliasi baru untuk mengaktifkan tab lain.",
    );
    expect(syncSource).toContain(
      "Tab mutasidev adalah sumber DEV dan tidak boleh dibaca dari production.",
    );
    expect(routeSource).toContain(
      "Perusahaan, Akun Rekonsiliasi, Label, dan Sheet ID wajib diisi",
    );
  });

  it("persists the configured bank account on every Google Sheet mutation", () => {
    expect(syncSource).toContain(
      "canonicalKey(row, config.company_id, config.bank_account_id)",
    );
    expect(syncSource).toContain("bm.bank_account_id = $5");
    expect(syncSource).toContain("config.bank_account_id");
    expect(isolationSql).toContain(
      "trg_enforce_google_sheet_mutation_scope",
    );
    expect(isolationSql).toContain(
      "Google Sheet mutation scope mismatch",
    );
  });

  it("supports filtering and matching by reconciliation account", () => {
    expect(routeSource).toContain("req.query.bank_account_id");
    expect(routeSource).toContain("bm.bank_account_id::text");
    expect(routeSource).toContain("bank_account_id?: unknown");
    expect(routeSource).toContain("bm.bank_account_id =");
  });
});
