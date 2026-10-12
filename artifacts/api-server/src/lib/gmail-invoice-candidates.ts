import crypto from "node:crypto";
import { pool } from "@workspace/db";
import {
  downloadAttachment,
  extractInvoiceDocument,
  listInvoiceMessages,
  numericAmount,
  type GmailAttachment,
  type GmailInvoiceMessage,
} from "./gmail-invoice-ocr";
import {
  GMAIL_MAX_ATTACHMENTS,
  GMAIL_MAX_ATTACHMENT_BYTES,
} from "./gmail-invoice-runtime";

type CandidateRow = {
  id: number;
  company_id: number;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  gmail_attachment_id: string;
  source_email: string;
  sender_email: string | null;
  sender_name: string | null;
  subject: string | null;
  received_at: string | Date | null;
  attachment_file_name: string;
  attachment_mime_type: string | null;
  attachment_size: number | null;
  attachment_sha256: string | null;
  extracted_vendor_name: string | null;
  extracted_invoice_number: string | null;
  extracted_invoice_date: string | Date | null;
  extracted_due_date: string | Date | null;
  extracted_currency: string | null;
  extracted_subtotal: string | number | null;
  extracted_tax: string | number | null;
  extracted_total: string | number | null;
  extracted_confidence: string | number | null;
  extracted_json: unknown;
  extraction_status: string;
  status: string;
  vendor_invoice_id: number | null;
  error_message: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

// SRT letters are not invoice/faktur documents. Keep historical rows for
// auditing, but exclude them from invoice candidates and future OCR sync.
function isSrtAttachment(fileName: string): boolean {
  return /^srt(?:[\s_.-]|$)/i.test(fileName.trim());
}

async function upsertShell(args: {
  companyId: number;
  message: GmailInvoiceMessage;
  attachment: GmailAttachment;
  sourceEmail: string;
  actorEmail: string;
}): Promise<CandidateRow> {
  const result = await pool.query<CandidateRow>(
    `insert into public.gmail_invoice_candidates(
       company_id,gmail_message_id,gmail_thread_id,gmail_attachment_id,
       source_email,sender_email,sender_name,subject,received_at,
       attachment_file_name,attachment_mime_type,attachment_size,
       extraction_status,status,created_by,updated_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending','new',$13,now())
     on conflict(company_id,gmail_message_id,gmail_attachment_id)
     do update set
       gmail_thread_id=excluded.gmail_thread_id,
       sender_email=excluded.sender_email,
       sender_name=excluded.sender_name,
       subject=excluded.subject,
       received_at=excluded.received_at,
       attachment_file_name=excluded.attachment_file_name,
       attachment_mime_type=excluded.attachment_mime_type,
       attachment_size=excluded.attachment_size,
       updated_at=now()
     returning *`,
    [
      args.companyId,
      args.message.id,
      args.message.threadId,
      args.attachment.attachmentId,
      args.sourceEmail,
      args.message.senderEmail,
      args.message.senderName,
      args.message.subject || null,
      args.message.receivedAt,
      args.attachment.fileName,
      args.attachment.mimeType,
      args.attachment.size || null,
      args.actorEmail,
    ],
  );
  return result.rows[0]!;
}

async function markFailed(id: number, error: unknown): Promise<void> {
  await pool.query(
    `update public.gmail_invoice_candidates
        set extraction_status='failed',
            status='manual_review',
            error_message=$1,
            updated_at=now()
      where id=$2`,
    [
      error instanceof Error
        ? error.message.slice(0, 1000)
        : String(error).slice(0, 1000),
      id,
    ],
  );
}

async function processAttachment(args: {
  companyId: number;
  accessToken: string;
  sourceEmail: string;
  actorEmail: string;
  message: GmailInvoiceMessage;
  attachment: GmailAttachment;
}): Promise<"ready" | "manual_review" | "duplicate" | "failed" | "existing"> {
  const candidate = await upsertShell(args);

  if (
    candidate.status === "imported" ||
    candidate.status === "duplicate" ||
    candidate.extraction_status === "complete"
  ) {
    return "existing";
  }

  try {
    const bytes = await downloadAttachment(
      args.accessToken,
      args.message.id,
      args.attachment,
    );

    if (!bytes.length) throw new Error("Attachment kosong.");
    if (bytes.length > GMAIL_MAX_ATTACHMENT_BYTES) {
      throw new Error("Attachment melebihi batas 15 MB.");
    }

    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const duplicateByHash = await pool.query<CandidateRow>(
      `select *
         from public.gmail_invoice_candidates
        where company_id=$1
          and attachment_sha256=$2
          and id<>$3
          and extraction_status='complete'
        order by id
        limit 1`,
      [args.companyId, hash, candidate.id],
    );

    if (duplicateByHash.rows[0]) {
      const original = duplicateByHash.rows[0];
      await pool.query(
        `update public.gmail_invoice_candidates
            set attachment_sha256=$1,
                extracted_vendor_name=$2,
                extracted_invoice_number=$3,
                extracted_invoice_date=$4,
                extracted_due_date=$5,
                extracted_currency=$6,
                extracted_subtotal=$7,
                extracted_tax=$8,
                extracted_total=$9,
                extracted_confidence=$10,
                extracted_json=$11::jsonb,
                extraction_status='complete',
                status='duplicate',
                vendor_invoice_id=$12,
                error_message='Attachment identik sudah pernah diproses',
                updated_at=now()
          where id=$13`,
        [
          hash,
          original.extracted_vendor_name,
          original.extracted_invoice_number,
          original.extracted_invoice_date,
          original.extracted_due_date,
          original.extracted_currency,
          original.extracted_subtotal,
          original.extracted_tax,
          original.extracted_total,
          original.extracted_confidence,
          JSON.stringify(original.extracted_json ?? {}),
          original.vendor_invoice_id,
          candidate.id,
        ],
      );
      return "duplicate";
    }

    const extraction = await extractInvoiceDocument(
      bytes,
      args.attachment,
      {
        subject: args.message.subject,
        sender: [
          args.message.senderName,
          args.message.senderEmail,
        ]
          .filter(Boolean)
          .join(" "),
      },
    );

    const existingInvoice = extraction.invoice_number
      ? await pool.query<{ id: number }>(
          `select id
             from public.vendor_invoices
            where company_id=$1
              and lower(coalesce(vendor_invoice_ref,''))=lower($2)
            order by id
            limit 1`,
          [args.companyId, extraction.invoice_number],
        )
      : { rows: [] as Array<{ id: number }> };

    const hasCoreFields = Boolean(
      extraction.vendor_name &&
        extraction.invoice_number &&
        extraction.total_amount != null &&
        extraction.total_amount > 0,
    );

    const status = existingInvoice.rows[0]
      ? "duplicate"
      : hasCoreFields && extraction.confidence >= 0.65
        ? "ready"
        : "manual_review";

    await pool.query(
      `update public.gmail_invoice_candidates
          set attachment_sha256=$1,
              attachment_size=$2,
              extracted_vendor_name=$3,
              extracted_invoice_number=$4,
              extracted_invoice_date=$5,
              extracted_due_date=$6,
              extracted_currency=$7,
              extracted_subtotal=$8,
              extracted_tax=$9,
              extracted_total=$10,
              extracted_confidence=$11,
              extracted_json=$12::jsonb,
              extraction_status='complete',
              status=$13,
              vendor_invoice_id=$14,
              error_message=$15,
              updated_at=now()
        where id=$16`,
      [
        hash,
        bytes.length,
        extraction.vendor_name,
        extraction.invoice_number,
        extraction.invoice_date,
        extraction.due_date,
        extraction.currency ?? "IDR",
        extraction.subtotal,
        extraction.tax,
        extraction.total_amount,
        extraction.confidence,
        JSON.stringify(extraction),
        status,
        existingInvoice.rows[0]?.id ?? null,
        status === "manual_review"
          ? "Data inti invoice belum lengkap atau confidence di bawah 65%"
          : status === "duplicate"
            ? "Nomor invoice vendor sudah tersimpan"
            : null,
        candidate.id,
      ],
    );

    return status;
  } catch (error) {
    await markFailed(candidate.id, error);
    return "failed";
  }
}

export async function syncGmailInvoiceCandidates(args: {
  companyId: number;
  accessToken: string;
  sourceEmail: string;
  actorEmail: string;
}) {
  const messages = await listInvoiceMessages(args.accessToken);
  const counts = {
    messagesScanned: messages.length,
    attachmentsSeen: 0,
    ready: 0,
    manualReview: 0,
    duplicates: 0,
    failed: 0,
    existing: 0,
  };

  let newWork = 0;

  scan: for (const message of messages) {
    for (const attachment of message.attachments) {
      if (isSrtAttachment(attachment.fileName)) continue;
      counts.attachmentsSeen += 1;

      const status = await processAttachment({
        ...args,
        message,
        attachment,
      });

      if (status === "ready") counts.ready += 1;
      else if (status === "manual_review") counts.manualReview += 1;
      else if (status === "duplicate") counts.duplicates += 1;
      else if (status === "failed") counts.failed += 1;
      else counts.existing += 1;

      if (status !== "existing") {
        newWork += 1;
        if (newWork >= GMAIL_MAX_ATTACHMENTS) break scan;
      }
    }
  }

  return counts;
}

function candidateView(row: CandidateRow) {
  return {
    id: row.id,
    messageId: row.gmail_message_id,
    senderEmail: row.sender_email,
    senderName: row.sender_name,
    subject: row.subject,
    receivedAt: row.received_at,
    fileName: row.attachment_file_name,
    mimeType: row.attachment_mime_type,
    size: row.attachment_size,
    vendorName: row.extracted_vendor_name,
    invoiceNumber: row.extracted_invoice_number,
    invoiceDate: row.extracted_invoice_date,
    dueDate: row.extracted_due_date,
    currency: row.extracted_currency,
    subtotal:
      row.extracted_subtotal == null
        ? null
        : Number(row.extracted_subtotal),
    tax:
      row.extracted_tax == null ? null : Number(row.extracted_tax),
    total:
      row.extracted_total == null ? null : Number(row.extracted_total),
    confidence:
      row.extracted_confidence == null
        ? null
        : Number(row.extracted_confidence),
    extractionStatus: row.extraction_status,
    status: row.status,
    vendorInvoiceId: row.vendor_invoice_id,
    error: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listGmailInvoiceCandidates(
  companyId: number,
  limit = 50,
) {
  const result = await pool.query<CandidateRow>(
    `select *
       from public.gmail_invoice_candidates
      where company_id=$1
        and attachment_file_name !~* '^srt([[:space:]_.-]|$)'
      order by received_at desc nulls last,id desc
      limit $2`,
    [companyId, Math.min(Math.max(limit, 1), 100)],
  );
  return result.rows.map(candidateView);
}

export async function importGmailInvoiceCandidate(args: {
  companyId: number;
  candidateId: number;
  actorEmail: string;
}) {
  const client = await pool.connect();

  try {
    await client.query("begin");

    const result = await client.query<CandidateRow>(
      `select *
         from public.gmail_invoice_candidates
        where id=$1 and company_id=$2
        for update`,
      [args.candidateId, args.companyId],
    );
    const candidate = result.rows[0];

    if (!candidate) {
      throw Object.assign(
        new Error("Kandidat invoice Gmail tidak ditemukan."),
        { status: 404 },
      );
    }

    // Never import an attachment already classified as a duplicate.
    // Its source row remains visible for audit, but it cannot create an AP invoice.
    if (candidate.status === "duplicate") {
      throw Object.assign(
        new Error("Invoice duplikat hanya disimpan di Sumber INV dan tidak dapat diimpor ke INV Vendor."),
        { status: 409 },
      );
    }

    if (candidate.vendor_invoice_id) {
      await client.query("commit");
      return {
        vendorInvoiceId: candidate.vendor_invoice_id,
        existing: true,
      };
    }

    if (candidate.extraction_status !== "complete") {
      throw Object.assign(
        new Error("OCR kandidat belum selesai."),
        { status: 409 },
      );
    }

    const vendorName = candidate.extracted_vendor_name?.trim() ?? "";
    const vendorReference =
      candidate.extracted_invoice_number?.trim() ?? "";
    const gross = Number(candidate.extracted_total ?? 0);
    const tax = Math.max(0, Number(candidate.extracted_tax ?? 0));
    const net = Number(
      candidate.extracted_subtotal ?? gross - tax,
    );

    if (
      !vendorName ||
      !vendorReference ||
      !Number.isFinite(gross) ||
      gross <= 0
    ) {
      throw Object.assign(
        new Error(
          "Nama vendor, nomor invoice, atau nominal hasil OCR belum lengkap.",
        ),
        { status: 409 },
      );
    }

    // Serialize the final duplicate check and invoice creation together.
    // Checking before acquiring the lock allows two concurrent imports of
    // the same vendor reference to both pass and create duplicate AP drafts.
    await client.query(
      "select pg_advisory_xact_lock(hashtext('vendor_invoices:invoice_number'))",
    );

    const existing = await client.query<{ id: number }>(
      `select id
         from public.vendor_invoices
        where company_id=$1
          and lower(coalesce(vendor_invoice_ref,''))=lower($2)
        limit 1`,
      [args.companyId, vendorReference],
    );

    if (existing.rows[0]) {
      await client.query(
        `update public.gmail_invoice_candidates
            set status='duplicate',
                vendor_invoice_id=$1,
                updated_at=now()
          where id=$2`,
        [existing.rows[0].id, candidate.id],
      );
      await client.query("commit");
      throw Object.assign(
        new Error("Invoice sudah ada di INV Vendor. Duplikat tetap berada di Sumber INV."),
        { status: 409 },
      );
    }

    const year = new Date().getFullYear();
    const sequence = await client.query<{ seq: string | number }>(
      `select coalesce(
          max(cast(split_part(invoice_number,'/',3) as int)),
          0
        ) as seq
         from public.vendor_invoices
        where invoice_number like $1`,
      [`VI/${year}/%`],
    );

    const invoiceNumber = `VI/${year}/${String(
      Number(sequence.rows[0]?.seq ?? 0) + 1,
    ).padStart(5, "0")}`;

    const supplier = await client.query<{ id: number }>(
      `select id
         from public.suppliers
        where lower(
          regexp_replace(coalesce(name,''),'[^[:alnum:]]','','g')
        ) = lower(
          regexp_replace($2,'[^[:alnum:]]','','g')
        )
          and (company_id=$1 or company_id is null)
        order by (company_id=$1) desc,id
        limit 1`,
      [args.companyId, vendorName],
    );

    const invoiceDate = candidate.extracted_invoice_date
      ? new Date(String(candidate.extracted_invoice_date))
      : candidate.received_at
        ? new Date(candidate.received_at)
        : new Date();

    const dueDate = candidate.extracted_due_date
      ? new Date(String(candidate.extracted_due_date))
      : new Date(invoiceDate.getTime() + 30 * 86400000);

    const extraction =
      candidate.extracted_json &&
      typeof candidate.extracted_json === "object"
        ? (candidate.extracted_json as Record<string, unknown>)
        : {};

    const created = await client.query<{ id: number }>(
      `insert into public.vendor_invoices(
         invoice_number,
         vendor_invoice_ref,
         company_id,
         supplier_id,
         supplier_name,
         status,
         invoice_date,
         due_date,
         payment_term_days,
         currency,
         total_amount,
         tax_amount,
         grand_total,
         amount_paid,
         notes,
         invoice_breakdown,
         attachment_file_name,
         attachment_content_type,
         attachment_size,
         created_by
       )
       values(
         $1,$2,$3,$4,$5,'draft',$6,$7,30,$8,
         $9,$10,$11,0,$12,$13::jsonb,$14,$15,$16,$17
       )
       returning id`,
      [
        invoiceNumber,
        vendorReference,
        args.companyId,
        supplier.rows[0]?.id ?? null,
        vendorName,
        invoiceDate,
        dueDate,
        candidate.extracted_currency || "IDR",
        Math.max(
          0,
          Number.isFinite(net) ? net : gross - tax,
        ),
        tax,
        gross,
        `Imported from Gmail candidate #${candidate.id}; message ${candidate.gmail_message_id}; sender ${candidate.sender_email ?? "-"}`,
        JSON.stringify({
          source: "gmail_invoice_source",
          gmailCandidateId: candidate.id,
          extraction,
        }),
        candidate.attachment_file_name,
        candidate.attachment_mime_type,
        candidate.attachment_size,
        args.actorEmail,
      ],
    );

    const vendorInvoiceId = created.rows[0]!.id;
    const rawLines = Array.isArray(extraction.line_items)
      ? extraction.line_items
      : [];

    const lines = rawLines.flatMap((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        return [];
      }

      const line = value as Record<string, unknown>;
      const quantity = Math.max(
        0.0001,
        numericAmount(line.quantity) ?? 1,
      );
      const lineTotal = numericAmount(line.total);
      const unitCost =
        numericAmount(line.unit_price) ??
        (lineTotal == null ? null : lineTotal / quantity);

      if (unitCost == null || !Number.isFinite(unitCost)) {
        return [];
      }

      return [
        {
          name:
            typeof line.description === "string" &&
            line.description.trim()
              ? line.description.trim()
              : `Invoice ${vendorReference}`,
          quantity,
          unitCost,
          subtotal: lineTotal ?? quantity * unitCost,
          tax: Math.max(0, numericAmount(line.tax) ?? 0),
          coaHint:
            typeof line.coa_hint === "string"
              ? line.coa_hint.trim() || null
              : null,
        },
      ];
    });

    if (lines.length === 0) {
      const fallbackNet = Math.max(
        0,
        Number.isFinite(net) ? net : gross - tax,
      );
      lines.push({
        name: `Invoice ${vendorReference}`,
        quantity: 1,
        unitCost: fallbackNet,
        subtotal: fallbackNet,
        tax,
        coaHint: null,
      });
    }

    for (const line of lines) {
      await client.query(
        `insert into public.vendor_invoice_lines(
           invoice_id,
           name,
           quantity,
           unit,
           unit_cost,
           subtotal,
           tax_amount,
           coa_hint,
           coa_resolution_status
         )
         values($1,$2,$3,'pcs',$4,$5,$6,$7,'unresolved')`,
        [
          vendorInvoiceId,
          line.name,
          line.quantity,
          line.unitCost,
          line.subtotal,
          line.tax,
          line.coaHint,
        ],
      );
    }

    await client.query(
      `update public.gmail_invoice_candidates
          set status='imported',
              vendor_invoice_id=$1,
              error_message=null,
              updated_at=now()
        where id=$2`,
      [vendorInvoiceId, candidate.id],
    );

    await client.query("commit");

    return {
      vendorInvoiceId,
      invoiceNumber,
      existing: false,
      status: "draft",
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
