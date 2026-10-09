import { getRuntimeConfig, GMAIL_SEARCH_QUERY, GMAIL_MAX_MESSAGES } from "./gmail-invoice-runtime";
import { fallbackInvoiceExtraction } from "./gmail-invoice-fallback";

const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export type GmailAttachment = {
  attachmentId: string;
  inlineData: string | null;
  fileName: string;
  mimeType: string;
  size: number;
};

export type GmailInvoiceMessage = {
  id: string;
  threadId: string | null;
  subject: string;
  senderEmail: string | null;
  senderName: string | null;
  receivedAt: Date | null;
  attachments: GmailAttachment[];
};

export type InvoiceExtraction = {
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total_amount: number | null;
  confidence: number;
  line_items: Array<{
    description: string | null;
    quantity: number | null;
    unit_price: number | null;
    total: number | null;
    tax: number | null;
    coa_hint: string | null;
  }>;
  flags: string[];
};

const INVOICE_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    vendor_name: { type: ["string", "null"] },
    invoice_number: { type: ["string", "null"] },
    invoice_date: { type: ["string", "null"] },
    due_date: { type: ["string", "null"] },
    currency: { type: ["string", "null"] },
    subtotal: { type: ["number", "null"] },
    tax: { type: ["number", "null"] },
    total_amount: { type: ["number", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    line_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: { type: ["string", "null"] },
          quantity: { type: ["number", "null"] },
          unit_price: { type: ["number", "null"] },
          total: { type: ["number", "null"] },
          tax: { type: ["number", "null"] },
          coa_hint: { type: ["string", "null"] },
        },
        required: [
          "description",
          "quantity",
          "unit_price",
          "total",
          "tax",
          "coa_hint",
        ],
      },
    },
    flags: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "vendor_name",
    "invoice_number",
    "invoice_date",
    "due_date",
    "currency",
    "subtotal",
    "tax",
    "total_amount",
    "confidence",
    "line_items",
    "flags",
  ],
} as const;

type Header = { name?: string; value?: string };
type Part = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: Part[];
};
type RawMessage = {
  id?: string;
  threadId?: string;
  internalDate?: string;
  payload?: Part;
};

function header(headers: Header[] | undefined, name: string): string {
  return String(
    headers?.find(
      (value) => String(value.name ?? "").toLowerCase() === name.toLowerCase(),
    )?.value ?? "",
  ).trim();
}

function parseSender(raw: string): {
  senderName: string | null;
  senderEmail: string | null;
} {
  const named = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (named) {
    return {
      senderName: named[1]?.trim() || null,
      senderEmail: named[2]?.trim().toLowerCase() || null,
    };
  }
  const email = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
  return {
    senderName: email
      ? raw.replace(email, "").replace(/[<>"]/g, "").trim() || null
      : raw || null,
    senderEmail: email?.toLowerCase() ?? null,
  };
}

function collectAttachments(
  part: Part | undefined,
  output: GmailAttachment[] = [],
): GmailAttachment[] {
  if (!part) return output;
  const fileName = String(part.filename ?? "").trim();
  const mimeType = String(part.mimeType ?? "").toLowerCase();
  if (
    fileName &&
    SUPPORTED_MIME_TYPES.has(mimeType) &&
    (part.body?.attachmentId || part.body?.data)
  ) {
    output.push({
      attachmentId: String(
        part.body?.attachmentId ?? `inline:${part.partId ?? fileName}`,
      ),
      inlineData: part.body?.data ?? null,
      fileName,
      mimeType,
      size: Number(part.body?.size ?? 0) || 0,
    });
  }
  for (const child of part.parts ?? []) {
    collectAttachments(child, output);
  }
  return output;
}

async function gmailJson<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json()) as T & {
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(
      payload.error?.message || `Gmail request failed: HTTP ${response.status}`,
    );
  }
  return payload;
}

export async function listInvoiceMessages(
  accessToken: string,
): Promise<GmailInvoiceMessage[]> {
  const listUrl = new URL(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  );
  listUrl.search = new URLSearchParams({
    q: GMAIL_SEARCH_QUERY,
    maxResults: String(GMAIL_MAX_MESSAGES),
  }).toString();

  const list = await gmailJson<{
    messages?: Array<{ id?: string }>;
  }>(listUrl.toString(), accessToken);

  const ids = (list.messages ?? [])
    .map((message) => message.id)
    .filter((id): id is string => Boolean(id))
    .slice(0, GMAIL_MAX_MESSAGES);

  const messages: GmailInvoiceMessage[] = [];
  for (const id of ids) {
    const raw = await gmailJson<RawMessage>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
      accessToken,
    );
    const subject = header(raw.payload?.headers, "Subject");
    const from = header(raw.payload?.headers, "From");
    const sender = parseSender(from);
    const internalDate = Number(raw.internalDate);
    const fallbackDate = header(raw.payload?.headers, "Date");
    const parsedDate =
      Number.isFinite(internalDate) && internalDate > 0
        ? new Date(internalDate)
        : fallbackDate
          ? new Date(fallbackDate)
          : null;

    messages.push({
      id,
      threadId: raw.threadId ?? null,
      subject,
      senderEmail: sender.senderEmail,
      senderName: sender.senderName,
      receivedAt:
        parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
      attachments: collectAttachments(raw.payload),
    });
  }
  return messages;
}

export async function downloadAttachment(
  accessToken: string,
  messageId: string,
  attachment: GmailAttachment,
): Promise<Buffer> {
  if (attachment.inlineData) {
    return Buffer.from(attachment.inlineData, "base64url");
  }

  const payload = await gmailJson<{ data?: string }>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`,
    accessToken,
  );
  if (!payload.data) {
    throw new Error("Attachment Gmail tidak memiliki data.");
  }
  return Buffer.from(payload.data, "base64url");
}

function amount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;

  const cleaned = value.replace(/[^0-9,.-]/g, "").trim();
  if (!cleaned) return null;

  const normalized =
    cleaned.includes(",") && cleaned.includes(".")
      ? cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned.replace(/,/g, "")
      : cleaned.includes(",")
        ? cleaned.replace(",", ".")
        : cleaned;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return Number.isNaN(new Date(`${trimmed}T00:00:00Z`).getTime())
    ? null
    : trimmed;
}

function sanitizeExtraction(raw: unknown): InvoiceExtraction {
  const row =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  let subtotal = amount(row.subtotal);
  let tax = amount(row.tax);
  let total = amount(row.total_amount);

  if (total == null && subtotal != null) total = subtotal + (tax ?? 0);
  if (subtotal == null && total != null && tax != null) {
    subtotal = Math.max(0, total - tax);
  }

  const confidenceValue = Number(row.confidence ?? 0);
  const lineItems = Array.isArray(row.line_items)
    ? row.line_items.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return [];
        }
        const line = value as Record<string, unknown>;
        return [
          {
            description:
              typeof line.description === "string"
                ? line.description.trim() || null
                : null,
            quantity: amount(line.quantity),
            unit_price: amount(line.unit_price),
            total: amount(line.total),
            tax: amount(line.tax),
            coa_hint:
              typeof line.coa_hint === "string"
                ? line.coa_hint.trim() || null
                : null,
          },
        ];
      })
    : [];

  return {
    vendor_name:
      typeof row.vendor_name === "string"
        ? row.vendor_name.trim() || null
        : null,
    invoice_number:
      typeof row.invoice_number === "string"
        ? row.invoice_number.trim() || null
        : null,
    invoice_date: dateOnly(row.invoice_date),
    due_date: dateOnly(row.due_date),
    currency:
      typeof row.currency === "string"
        ? row.currency.trim().toUpperCase() || "IDR"
        : "IDR",
    subtotal,
    tax,
    total_amount: total,
    confidence: Number.isFinite(confidenceValue)
      ? Math.max(0, Math.min(1, confidenceValue))
      : 0,
    line_items: lineItems,
    flags: Array.isArray(row.flags)
      ? row.flags
          .filter((value): value is string => typeof value === "string")
          .slice(0, 20)
      : [],
  };
}

function responseText(payload: unknown): string {
  const row =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  if (typeof row.output_text === "string") return row.output_text;
  if (!Array.isArray(row.output)) return "";

  const chunks: string[] = [];
  for (const item of row.output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string") chunks.push(text);
    }
  }
  return chunks.join("\n").trim();
}

export async function extractInvoiceDocument(
  bytes: Buffer,
  attachment: GmailAttachment,
  context: { subject: string; sender: string },
): Promise<InvoiceExtraction> {
  const apiKey = await getRuntimeConfig("OPENAI_API_KEY");
  if (!apiKey) {
    return fallbackInvoiceExtraction(
      bytes,
      attachment,
      context,
      new Error("OPENAI_API_KEY belum tersedia di konfigurasi BizPortal."),
    );
  }

  const prompt = [
    "Extract vendor invoice data from this document and return JSON only.",
    "Do not guess missing data. Vendor is the issuer, not the recipient.",
    "Use ISO dates YYYY-MM-DD. Amounts must be numeric.",
    "subtotal/DPP is pre-VAT, tax is PPN/VAT, total_amount is gross.",
    `Email subject: ${context.subject || "(none)"}`,
    `Email sender: ${context.sender || "(none)"}`,
    "Follow the enforced response schema exactly.",
  ].join("\n");

  const encoded = bytes.toString("base64");
  const content =
    attachment.mimeType === "application/pdf"
      ? [
          { type: "input_text", text: prompt },
          {
            type: "input_file",
            filename: attachment.fileName,
            file_data: `data:application/pdf;base64,${encoded}`,
            detail: "high",
          },
        ]
      : [
          { type: "input_text", text: prompt },
          {
            type: "input_image",
            image_url: `data:${attachment.mimeType};base64,${encoded}`,
            detail: "high",
          },
        ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model:
        (await getRuntimeConfig("GMAIL_INVOICE_OCR_MODEL")) || "gpt-6-luna",
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name: "gmail_invoice_extraction",
          strict: true,
          schema: INVOICE_EXTRACTION_SCHEMA,
        },
      },
      max_output_tokens: 2200,
    }),
  });

  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error =
      payload.error &&
      typeof payload.error === "object" &&
      !Array.isArray(payload.error)
        ? (payload.error as Record<string, unknown>)
        : {};
    return fallbackInvoiceExtraction(
      bytes,
      attachment,
      context,
      new Error(
        typeof error.message === "string"
          ? error.message
          : `OpenAI OCR gagal: HTTP ${response.status}`,
      ),
    );
  }

  const text = responseText(payload)
    .replace(/^\s*```json\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  if (!text) {
    return fallbackInvoiceExtraction(
      bytes,
      attachment,
      context,
      new Error("OCR AI tidak mengembalikan hasil."),
    );
  }

  try {
    return sanitizeExtraction(JSON.parse(text));
  } catch {
    return fallbackInvoiceExtraction(
      bytes,
      attachment,
      context,
      new Error("OCR AI mengembalikan JSON yang tidak valid."),
    );
  }
}

export function numericAmount(value: unknown): number | null {
  return amount(value);
}
