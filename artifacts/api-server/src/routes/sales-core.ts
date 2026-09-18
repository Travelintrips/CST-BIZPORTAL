import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { authenticateAdmin, type AdminRequest } from "./admin-auth";

const router: IRouter = Router();

function isoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function numeric(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

router.use(authenticateAdmin);

router.get("/sales/ai-drafts", async (request, response): Promise<void> => {
  const adminRequest = request as AdminRequest;
  const companyId = adminRequest.adminUser?.companyId ?? null;

  try {
    const result = await pool.query<{
      id: number;
      doc_number: string;
      kind: string;
      status: string;
      invoice_status: string;
      delivery_status: string;
      payment_status: string;
      customer_id: number | null;
      customer_name: string;
      total_amount: string | number;
      tax_rate_id: number | null;
      tax_amount: string | number;
      grand_total: string | number;
      origin: string | null;
      destination: string | null;
      transport_mode: string | null;
      etd: string | Date | null;
      eta: string | Date | null;
      valid_until: string | Date | null;
      expected_date: string | Date | null;
      notes: string | null;
      confirmed_at: string | Date | null;
      amount_paid: string | number;
      created_at: string | Date;
      updated_at: string | Date;
      ai_generated: boolean;
      ai_source_wa_phone: string | null;
      ai_source_correspondence_id: number | null;
    }>(
      `select
         id, doc_number, kind::text kind, status::text status,
         invoice_status::text invoice_status, delivery_status::text delivery_status,
         payment_status::text payment_status, customer_id, customer_name,
         total_amount, tax_rate_id, tax_amount, grand_total,
         origin, destination, transport_mode, etd, eta, valid_until, expected_date,
         notes, confirmed_at, amount_paid, created_at, updated_at,
         ai_generated, ai_source_wa_phone, ai_source_correspondence_id
       from public.sales_documents
       where ai_generated = true
         and status::text = 'draft'
         and ($1::bigint is null or company_id = $1)
       order by created_at desc`,
      [companyId],
    );

    response.json(result.rows.map((row) => ({
      id: row.id,
      docNumber: row.doc_number,
      kind: row.kind,
      status: row.status,
      invoiceStatus: row.invoice_status,
      deliveryStatus: row.delivery_status,
      paymentStatus: row.payment_status,
      customerId: row.customer_id,
      customerName: row.customer_name,
      totalAmount: numeric(row.total_amount),
      taxRateId: row.tax_rate_id,
      taxAmount: numeric(row.tax_amount),
      grandTotal: numeric(row.grand_total),
      origin: row.origin,
      destination: row.destination,
      transportMode: row.transport_mode,
      etd: isoDate(row.etd),
      eta: isoDate(row.eta),
      validUntil: isoDate(row.valid_until),
      expectedDate: isoDate(row.expected_date),
      notes: row.notes,
      confirmedAt: isoDate(row.confirmed_at),
      customerAddress: null,
      amountPaid: numeric(row.amount_paid),
      createdAt: isoDate(row.created_at),
      updatedAt: isoDate(row.updated_at),
      aiGenerated: row.ai_generated,
      aiSourceWaPhone: row.ai_source_wa_phone,
      aiSourceCorrespondenceId: row.ai_source_correspondence_id,
    })));
  } catch (error) {
    request.log.error({ error }, "Failed to load AI draft quotations");
    response.status(503).json({ error: "Draft quotation data cannot be loaded." });
  }
});

export default router;