import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const purchaseApi = readFileSync(new URL("../routes/purchase-workflow.ts", import.meta.url), "utf8");
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

  it("only scans Gmail invoice attachments when Sync Now is explicitly clicked", () => {
    expect(routes).toContain('"/recon-classification/invoice-sources/gmail/sync"');
    expect(routes).toContain("await syncGmailInvoiceCandidates({");
    expect(routes).toContain("autoSyncEnabled: false");
    expect(routes).toContain("autoSyncIntervalMinutes: 0");
    expect(routes).not.toContain("runGmailOrganizerTick");
    expect(routes).not.toContain("GMAIL_ORGANIZER_POLL_MS");
    expect(routes).not.toContain("setInterval(");
    expect(routes).not.toContain('"/recon-classification/invoice-sources/gmail/auto-sync"');
    expect(sourcePage).toContain("Mode manual — tidak ada sinkronisasi terjadwal");
    expect(sourcePage).toContain("Sync Now");
    expect(sourcePage).not.toContain("Aktifkan Auto Sync");
  });

  it("archives only untouched drafts and retains audit and ledger evidence", () => {
    expect(purchaseApi).toContain('router.delete("/purchase-workflow/vendor-invoices/:id"');
    expect(purchaseApi).toContain('invoice.status !== "draft"');
    expect(purchaseApi).toContain("vi.cancelled_at is null");
    expect(purchaseApi).toContain("journal_entry_id is null");
    expect(purchaseApi).toContain("payment_request_items");
    expect(purchaseApi).toContain("bank_disbursement_items");
    expect(purchaseApi).toContain("payment_allocations");
    expect(purchaseApi).toContain("archive_draft");
    expect(purchaseApi).toContain("await client.query(\"commit\")");
    expect(purchaseApi).not.toContain('router.delete("/purchase-workflow/vendor-invoices/:id", (req, res) =>');
  });

  it("only shows actionable AP deletion for drafts", () => {
    expect(invoicePage).toContain('disabled={item.status !== "draft"}');
    expect(invoicePage).toContain('vi.status === "draft" && (');
    expect(invoicePage).toContain("Sumber Gmail / Sync Now");
    expect(invoicePage).toContain("Ya, Arsipkan Draft");
  });
});
