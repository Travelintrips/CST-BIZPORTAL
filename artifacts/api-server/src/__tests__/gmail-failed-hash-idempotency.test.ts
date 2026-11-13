import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  nextId: 1,
  scan: 0,
  extractionCalls: 0,
  importedInvoices: 0,
}));

vi.mock("@workspace/db", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const q = sql.replace(/\s+/g, " ").toLowerCase();
      const rows = mock.rows;
      if (q.includes("insert into public.gmail_invoice_candidates")) {
        const existing = rows.find((r) =>
          r.company_id === params[0] && r.gmail_message_id === params[1] &&
          r.gmail_attachment_id === params[3]);
        if (existing) return { rows: [existing] };
        const row: Record<string, unknown> = {
          id: mock.nextId++, company_id: params[0], gmail_message_id: params[1],
          gmail_attachment_id: params[3], source_email: params[4],
          attachment_file_name: params[9], attachment_sha256: null,
          status: "new", extraction_status: "pending", vendor_invoice_id: null,
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (q.includes("from public.gmail_invoice_candidates") &&
          q.includes("status='manual_review'") &&
          q.includes("extraction_status='failed'")) {
        return { rows: rows.filter((r) =>
          r.company_id === params[0] && r.gmail_message_id === params[1] &&
          r.attachment_sha256 === params[2] && r.id !== params[3] &&
          r.status === "manual_review" && r.extraction_status === "failed") .slice(0, 1) };
      }
      if (q.includes("delete from public.gmail_invoice_candidates")) {
        const index = rows.findIndex((r) => r.id === params[0] &&
          r.company_id === params[1] && r.status === "new" &&
          r.extraction_status === "pending" && r.vendor_invoice_id === null);
        if (index < 0) return { rows: [] };
        return { rows: [rows.splice(index, 1)[0]] };
      }
      if (q.includes("set attachment_sha256=$1, updated_at=now()")) {
        const row = rows.find((r) => r.id === params[1] && r.company_id === params[2]);
        if (row) row.attachment_sha256 = params[0];
        return { rows: [] };
      }
      if (q.includes("status='rejected'") && q.includes("select id")) return { rows: [] };
      if (q.includes("from public.gmail_invoice_candidates") &&
          q.includes("gmail_message_id=$2") &&
          q.includes("extraction_status='complete'")) {
        const found = rows.find((r) => r.company_id === params[0] &&
          r.gmail_message_id === params[1] && r.attachment_sha256 === params[2] &&
          r.id !== params[3] && r.extraction_status === "complete");
        return { rows: found ? [found] : [] };
      }
      if (q.includes("from public.gmail_invoice_candidates") && q.includes("extraction_status='complete'")) {
        const found = rows.find((r) => r.company_id === params[0] &&
          r.attachment_sha256 === params[1] && r.id !== params[2] &&
          r.extraction_status === "complete");
        return { rows: found ? [found] : [] };
      }
      if (q.includes("from public.vendor_invoices")) return { rows: [] };
      if (q.includes("set extraction_status='failed'")) {
        const row = rows.find((r) => r.id === params[1]);
        if (row) { row.extraction_status = "failed"; row.status = "manual_review"; }
        return { rows: [] };
      }
      if (q.includes("set attachment_sha256=$1") && q.includes("extraction_status='complete'")) {
        const row = rows.find((r) => r.id === params[15]);
        if (row) {
          row.attachment_sha256 = params[0];
          row.status = params[12];
          row.extraction_status = "complete";
          row.vendor_invoice_id = params[13];
        }
        return { rows: [] };
      }
      return { rows: [] };
    }),
  },
}));

vi.mock("../lib/gmail-invoice-ocr", () => ({
  listInvoiceMessages: vi.fn(async () => [{
    id: "message-A", threadId: "thread-A",
    senderEmail: "vendor@example.org", senderName: "Vendor",
    subject: "invoice", receivedAt: "2026-11-13T00:00:00Z",
    attachments: [{
      attachmentId: `rotated-${mock.scan++}`, fileName: "invoice.pdf",
      mimeType: "application/pdf", size: 16,
    }],
  }]),
  downloadAttachment: vi.fn(async () => Buffer.from("same invoice file content")),
  extractInvoiceDocument: vi.fn(async () => {
    mock.extractionCalls++;
    if (mock.extractionCalls === 1) throw new Error("OCR temporarily unavailable");
    return {
      vendor_name: "Vendor", invoice_number: "INV-2026-001",
      total_amount: 1000, confidence: 0.95, flags: [],
      invoice_date: "2026-11-13", due_date: "2026-11-20",
      currency: "IDR", subtotal: 1000, tax: 0,
    };
  }),
  numericAmount: vi.fn((v: unknown) => Number(v)),
}));

vi.mock("../lib/gmail-invoice-runtime", () => ({
  GMAIL_MAX_ATTACHMENTS: 6, GMAIL_MAX_ATTACHMENT_BYTES: 15 * 1024 * 1024,
}));
vi.mock("../lib/gmail-invoice-rate-limit", () => ({
  GmailProviderRateLimitError: class GmailProviderRateLimitError extends Error {},
  requiresInvoiceExtractionReview: () => false,
}));

import { syncGmailInvoiceCandidates } from "../lib/gmail-invoice-candidates";

describe("Gmail source deduplication on OCR failure and attachmentId rotation", () => {
  beforeEach(() => {
    mock.rows.length = 0;
    mock.nextId = 1;
    mock.scan = 0;
    mock.extractionCalls = 0;
    mock.importedInvoices = 0;
  });

  it("reuses the failed row then ignores a repeated completed file", async () => {
    const params = {
      companyId: 1, accessToken: "test-token", sourceEmail: "test@example.org",
      actorEmail: "finance@example.org",
    };

    const failed = await syncGmailInvoiceCandidates(params);
    expect(failed.failed).toBe(1);
    expect(mock.rows).toHaveLength(1);
    expect(mock.rows[0].extraction_status).toBe("failed");
    expect(mock.rows[0].attachment_sha256).toBe(
      crypto.createHash("sha256").update("same invoice file content").digest("hex"),
    );

    const retry = await syncGmailInvoiceCandidates(params);
    expect(retry.ready).toBe(1);
    expect(mock.rows).toHaveLength(1);
    expect(mock.rows[0].id).toBe(1);
    expect(mock.rows[0].status).toBe("ready");

    const repeat = await syncGmailInvoiceCandidates(params);
    expect(repeat.existing).toBe(1);
    expect(mock.rows).toHaveLength(1);
    expect(mock.extractionCalls).toBe(2);
    expect(mock.importedInvoices).toBe(0);
  });
});
