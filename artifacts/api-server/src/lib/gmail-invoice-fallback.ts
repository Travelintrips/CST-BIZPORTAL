// Bundle the parser into dist/index.mjs. A runtime createRequire() fails on
// Hostinger deployments where the internal package path is not shipped.
// @ts-ignore pdf-parse v1 does not publish declarations for its internal entry.
import pdfParseModule from "pdf-parse/lib/pdf-parse.js";
import type { GmailAttachment, InvoiceExtraction } from "./gmail-invoice-ocr";

type PdfParseFn = (buffer: Buffer) => Promise<{ text: string; numpages: number }>;
const pdfParse = pdfParseModule as PdfParseFn;

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/\b(?:idr|rp|usd)\b/gi, "").replace(/[^\d.,-]/g, "").trim();
  if (!cleaned) return null;
  const comma = cleaned.lastIndexOf(",");
  const dot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (comma >= 0 && dot >= 0) {
    normalized = comma > dot ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
  } else if (comma >= 0) {
    normalized = cleaned.length - comma - 1 === 2 ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
  } else if (dot >= 0 && cleaned.length - dot - 1 !== 2) {
    normalized = cleaned.replace(/\./g, "");
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function amountAfter(text: string, labels: RegExp[]): number | null {
  for (const label of labels) {
    const match = text.match(label);
    if (!match?.[1]) continue;
    const value = parseAmount(match[1]);
    if (value != null) return value;
  }
  return null;
}

function senderVendor(sender: string): string | null {
  const domain = sender.match(/@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.slice(1).toLowerCase() ?? "";
  if (domain.includes("injourneyairports")) return "InJourney Airports";
  if (domain.includes("fltechnics")) return "FL Technics";
  if (domain.includes("hostinger")) return "Hostinger";
  const name = sender.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, "").replace(/[<>"]/g, " ").replace(/\s+/g, " ").trim();
  return name || null;
}

function vendorFromText(text: string, sender: string): string | null {
  const patterns = [
    /pengusaha\s+kena\s+pajak[\s\S]{0,220}?\bnama\s*[:\-]\s*([^\n]{3,100})/i,
    /\b(?:vendor|supplier|penerbit)\s*[:\-]\s*([^\n]{3,100})/i,
    /\bnama\s*[:\-]\s*((?:PT|CV)\.?\s+[^\n]{2,100})/i,
  ];
  for (const pattern of patterns) {
    const value = text.match(pattern)?.[1]?.replace(/\s+/g, " ").trim();
    if (value) return value;
  }
  return senderVendor(sender);
}

function invoiceNumber(text: string, fileName: string): string | null {
  const patterns = [
    /kode\s+dan\s+nomor\s+seri\s+faktur\s+pajak\s*[:\-]?\s*([A-Z0-9./_-]{6,})/i,
    /(?:invoice|inv)\s*(?:no|number|#)?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9./_-]{4,})/i,
    /(?:nomor|no\.?)\s*(?:invoice|faktur)?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9./_-]{4,})/i,
  ];
  for (const pattern of patterns) {
    const value = text.match(pattern)?.[1]?.trim();
    if (value) return value;
  }
  return fileName.match(/\b((?:INV|FK)[A-Z0-9_.-]{5,})\b/i)?.[1] ?? null;
}

const MONTHS: Record<string,string> = {
  januari:"01",februari:"02",maret:"03",april:"04",mei:"05",juni:"06",juli:"07",agustus:"08",september:"09",oktober:"10",november:"11",desember:"12",
  january:"01",february:"02",march:"03",may:"05",june:"06",july:"07",august:"08",october:"10",december:"12",
};

function looseDate(raw: string): string | null {
  const numeric = raw.match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/);
  if (numeric) {
    const year = numeric[3]!.length === 2 ? "20" + numeric[3] : numeric[3]!;
    return year + "-" + numeric[2]!.padStart(2,"0") + "-" + numeric[1]!.padStart(2,"0");
  }
  const named = raw.match(/\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/);
  if (!named) return null;
  const month = MONTHS[named[2]!.toLowerCase()];
  return month ? named[3] + "-" + month + "-" + named[1]!.padStart(2,"0") : null;
}

function dateAfter(text: string, labels: RegExp[]): string | null {
  for (const label of labels) {
    const match = text.match(label);
    const value = match?.[1] ? looseDate(match[1]) : null;
    if (value) return value;
  }
  return null;
}

export async function fallbackInvoiceExtraction(
  bytes: Buffer,
  attachment: GmailAttachment,
  context: { subject: string; sender: string },
  reason?: unknown,
): Promise<InvoiceExtraction> {
  let text = "";
  if (attachment.mimeType === "application/pdf") {
    try {
      const parsed = await pdfParse(bytes);
      text = String(parsed.text ?? "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 50000);
    } catch { text = ""; }
  }
  const combined = [context.subject, context.sender, text].filter(Boolean).join("\n");
  let subtotal = amountAfter(combined, [
    /(?:dasar\s+pengenaan\s+pajak|\bdpp\b|\bsubtotal\b|\bnet(?:to)?\b)[^\d]{0,24}(?:Rp\.?\s*)?([\d.,]+)/i,
  ]);
  let tax = amountAfter(combined, [
    /(?:\bppn\b|\bvat\b|pajak\s+pertambahan\s+nilai)[^\d]{0,24}(?:Rp\.?\s*)?([\d.,]+)/i,
  ]);
  let total = amountAfter(combined, [
    /(?:grand\s+total|total\s+tagihan|jumlah\s+tagihan|total\s+amount|amount\s+due|\btotal\b|\bjumlah\b)[^\d]{0,24}(?:Rp\.?\s*)?([\d.,]+)/i,
  ]);
  if (total == null && subtotal != null && tax != null) total = subtotal + tax;
  if (subtotal == null && total != null && tax != null && total >= tax) subtotal = total - tax;
  const vendor = vendorFromText(combined, context.sender);
  const number = invoiceNumber(combined, attachment.fileName);
  const invoiceDate = dateAfter(combined, [/(?:tanggal\s+invoice|invoice\s+date|tanggal\s+faktur|\btanggal\b)\s*[:\-]?\s*([^\n]{0,40})/i]);
  const dueDate = dateAfter(combined, [/(?:jatuh\s+tempo|due\s+date)\s*[:\-]?\s*([^\n]{0,40})/i]);
  const hasCore = Boolean(vendor && number && total != null && total > 0);
  const flags = ["FALLBACK_PDF_TEXT", "AI OCR unavailable; deterministic extraction used."];
  if (!text) flags.push("PDF text layer unavailable or document is image-only.");
  if (!number) flags.push("Invoice number not confidently identified.");
  if (total == null) flags.push("Total amount not confidently identified.");
  if (reason instanceof Error) flags.push("OCR_PROVIDER_ERROR");
  const confidence = hasCore ? 0.72 : total != null ? 0.5 : text.length >= 120 ? 0.35 : 0.2;
  return {
    vendor_name: vendor, invoice_number: number, invoice_date: invoiceDate, due_date: dueDate, currency: "IDR",
    subtotal, tax, total_amount: total, confidence,
    line_items: total != null ? [{ description: context.subject || attachment.fileName, quantity: 1, unit_price: subtotal ?? total, total: subtotal ?? total, tax, coa_hint: null }] : [],
    flags,
  };
}
