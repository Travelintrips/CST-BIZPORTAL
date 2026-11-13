import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const api = readFileSync(new URL("../routes/gmail-invoice-source.ts", import.meta.url), "utf8");
const candidates = readFileSync(new URL("../lib/gmail-invoice-candidates.ts", import.meta.url), "utf8");
const panel = readFileSync(new URL("../../../bizportal/src/pages/finance/recon-config/InvoiceSourcesTab.tsx", import.meta.url), "utf8");
const configPage = readFileSync(new URL("../../../bizportal/src/pages/finance/recon-config/index.tsx", import.meta.url), "utf8");
const vendorPage = readFileSync(new URL("../../../bizportal/src/pages/purchase/vendor-invoices.tsx", import.meta.url), "utf8");

describe("Reuse existing Gmail invoice UI in DEV without AP changes", () => {
  it("keeps the original source panel and reaches it through the existing recon tab", () => {
    expect(configPage).toContain('import InvoiceSourcesTab from "./InvoiceSourcesTab"');
    expect(configPage).toContain('value="invoice-sources"');
    expect(configPage).toContain("<InvoiceSourcesTab />");
    expect(vendorPage).toContain("Sumber Gmail / Sync Now");
    expect(vendorPage).toContain('/finance/recon-config?tab=invoice-sources');
  });

  it("keeps Gmail sync manual and does not expose a scheduler", () => {
    expect(panel).toContain("Mode manual — tidak ada sinkronisasi terjadwal");
    expect(panel).toContain("Sync Now");
    expect(panel).not.toContain("Aktifkan Auto Sync");
    expect(api).toContain("autoSyncEnabled: false");
    expect(api).not.toContain("setInterval(");
  });

  it("keeps duplicate, supporting tax, rejection and Finance review protections", () => {
    expect(panel).toContain("Faktur Pendukung");
    expect(panel).toContain("Tolak kandidat invoice Gmail?");
    expect(panel).toContain("Pulihkan");
    expect(candidates).toContain("isSupportingTaxAttachment");
    expect(candidates).toContain("GMAIL_CANDIDATE_REJECTED");
  });
});
