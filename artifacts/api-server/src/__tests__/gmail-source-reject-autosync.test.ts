import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const candidates = readFileSync(new URL("../lib/gmail-invoice-candidates.ts", import.meta.url), "utf8");
const routes = readFileSync(new URL("../routes/gmail-invoice-source.ts", import.meta.url), "utf8");
const invoicePage = readFileSync(new URL("../../../bizportal/src/pages/purchase/vendor-invoices.tsx", import.meta.url), "utf8");
const sourcePage = readFileSync(new URL("../../../bizportal/src/pages/finance/recon-config/InvoiceSourcesTab.tsx", import.meta.url), "utf8");

describe("Gmail source rejection and automatic sync safeguards", () => {
  it("retains rejection across the source Gmail upsert and blocks import", () => {
    expect(candidates).toContain("candidate.status === \"rejected\"");
    expect(candidates).toContain('status=\'rejected\'');
    expect(candidates).toContain("GMAIL_CANDIDATE_REJECTED");
    expect(candidates).toContain("source_review_history");
    expect(candidates).toContain("vendor_invoice_id is null");
    expect(candidates).toContain("attachment_sha256=$2 and status='rejected'");
  });

  it("requires a reason and scopes reject/restore decisions to the active company", () => {
    expect(candidates).toContain("reason.length < 10 || reason.length > 500");
    expect(candidates).toContain("where id=$1 and company_id=$2 and vendor_invoice_id is null");
    expect(routes).toContain('"/recon-classification/invoice-sources/gmail/candidates/:id/review"');
    expect(routes).toContain("const companyId = requireCompanyScope(");
    expect(routes).toContain('decision !== "reject" && decision !== "restore"');
    expect(sourcePage).toContain("Tolak kandidat invoice Gmail?");
    expect(sourcePage).toContain('["rejected", "Ditolak"]');
    expect(sourcePage).toContain("Pulihkan");
  });

  it("uses the existing ten-minute background job with a company-scoped toggle", () => {
    expect(routes).toContain("const GMAIL_ORGANIZER_POLL_MS = 10 * 60 * 1000");
    expect(routes).toContain('getConfig(companyId, "AUTO_SYNC_ENABLED")');
    expect(routes).toContain('"/recon-classification/invoice-sources/gmail/auto-sync"');
    expect(sourcePage).toContain("Nonaktifkan Auto Sync");
    expect(sourcePage).toContain("Aktifkan Auto Sync");
  });

  it("only shows actionable AP deletion for drafts", () => {
    expect(invoicePage).toContain('disabled={item.status !== "draft"}');
    expect(invoicePage).toContain('vi.status === "draft" && (');
    expect(invoicePage).toContain("Sumber Gmail / Auto Sync");
  });
});
