import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tab = readFileSync(
  new URL("../../../bizportal/src/pages/finance/recon-config/InvoiceSourcesTab.tsx", import.meta.url),
  "utf8",
);

describe("Gmail invoice source tenant-safe status display", () => {
  it("does not claim Gmail is disconnected when authenticated status is unavailable", () => {
    expect(tab).toContain("status === null ? (");
    expect(tab).toContain("Status belum tersedia");
    expect(tab).toContain("Belum terhubung");
  });

  it("distinguishes stored OAuth credentials from a successful invoice sync", () => {
    expect(tab).toContain("Token Gmail tersimpan");
    expect(tab).toContain("status?.connected && !status.lastSyncAt");
    expect(tab).toContain("belum ada sinkronisasi invoice yang");
  });

  it("shows the company scope and never falls back to the PROD mailbox in DEV UI", () => {
    expect(tab).toContain("Token perusahaan lain tidak digunakan.");
    expect(tab).toContain("companyId ? ` (ID ${companyId})` : \"\"");
    expect(tab).toContain('"Belum dikonfigurasi"');
    expect(tab).not.toContain('"travelincars01@gmail.com"');
  });

  it("explains missing DEV source mailbox and avoids hardcoded account mismatch", () => {
    expect(tab).toContain("status !== null && !status.expectedEmail");
    expect(tab).toContain("GMAIL_INVOICE_SOURCE_EMAIL");
    expect(tab).toContain("Akun Google yang dipilih bukan Gmail sumber");
  });
});
