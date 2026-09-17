import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getDevSession, isDevelopmentEnvironment, type DevAuthUser } from "./dev-auth";

const router: IRouter = Router();

interface VendorInvoiceListRow {
  id: number;
  invoice_number: string;
  vendor_invoice_ref: string | null;
  supplier_name: string | null;
  status: string;
  grand_total: string;
  reconciled_amount_paid: string;
  three_way_match_status: string | null;
  company_id: number;
  invoice_date: string | Date | null;
  journal_entry_id: number | null;
  journal_status: string | null;
}

interface LiabilityAccountRow {
  id: number;
  code: string;
  name: string;
}

interface VendorInvoiceDetailRow {
  id: number;
  invoice_number: string;
  vendor_invoice_ref: string | null;
  company_id: number;
  supplier_id: number | null;
  supplier_name: string | null;
  po_id: number | null;
  gr_id: number | null;
  status: string;
  invoice_date: string | Date | null;
  due_date: string | Date | null;
  payment_term_days: number | null;
  total_amount: string;
  tax_amount: string;
  grand_total: string;
  reconciled_amount_paid: string;
  three_way_match_status: string | null;
  match_notes: string | null;
  journal_entry_id: number | null;
  journal_status: string | null;
  journal_entry_number: string | null;
  withholding_tax_amount: string | null;
  withholding_tax_type: string | null;
  invoice_breakdown: unknown;
}

interface VendorInvoiceLineRow {
  id: number;
  product_id: number | null;
  name: string | null;
  quantity: string | number;
  unit: string | null;
  unit_cost: string | number;
  subtotal: string | number;
  tax_amount: string | number;
  notes: string | null;
  coa_account_id: number | null;
}

interface VendorInvoiceLineTaxRow {
  id: number;
  invoice_line_id: number;
  tax_type: string | null;
  tax_object: string | null;
  tax_amount: string | number;
  liability_account_id: number | null;
  resolution_status: string | null;
}

interface VendorWithholdingRecordRow {
  id: number;
  vendor_invoice_id: number;
  invoice_line_id: number | null;
  line_tax_id: number | null;
  tax_type: string | null;
  tax_object: string | null;
  tax_amount: string | number;
  liability_account_id: number | null;
  status: string | null;
}

function getLocalApiUser(req: Request): DevAuthUser | null {
  const devUser = getDevSession(req);
  if (devUser) return devUser;
  if (isDevelopmentEnvironment()) return null;

  // Production currently runs the BizPortal UI in its intentional shared
  // admin/no-login mode. Keep local Supabase purchase actions consistent with
  // that mode while still applying the route's role and company checks.
  return {
    id: "production-no-login",
    email: "production-no-login@bizportal.local",
    firstName: "CST",
    lastName: "Admin",
    role: "admin",
    companyId: null,
  };
}

router.use((req, res, next) => {
  const user = getLocalApiUser(req);
  if (!user || !["admin", "owner", "finance", "accounting"].includes(user.role)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

function first(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function sendError(res: Response, status: number, error: string, code: string, details?: unknown): void {
  res.status(status).json({ error, code, ...(details === undefined ? {} : { details }) });
}

/**
 * `vendor_invoices.amount_paid` is a legacy denormalized value and is not the
 * source of truth for the AP screen. A vendor invoice is paid only by active
 * allocations owned by a final Bank Reconciliation settlement.
 *
 * The allocation table has had more than one amount-column name across the
 * upstream schema revisions. Reading the JSON representation keeps this
 * projection compatible without changing the schema or mutating any data.
 */
const CANONICAL_VENDOR_INVOICE_PAID_SQL = `
  coalesce((
    select sum(
      coalesce(
        nullif(to_jsonb(pa)->>'amount', '')::numeric,
        nullif(to_jsonb(pa)->>'allocated_amount', '')::numeric,
        nullif(to_jsonb(pa)->>'allocation_amount', '')::numeric,
        0
      )
    )
    from public.payment_allocations pa
    left join public.payment_matching_groups pmg
      on pmg.id = nullif(to_jsonb(pa)->>'group_id', '')::bigint
    left join public.bank_mutations bm
      on bm.id = nullif(to_jsonb(pa)->>'mutation_id', '')::bigint
    where coalesce(
            nullif(to_jsonb(pa)->>'vendor_invoice_id', ''),
            nullif(to_jsonb(pa)->>'invoice_id', '')
          ) = vi.id::text
      and nullif(to_jsonb(pa)->>'company_id', '') = vi.company_id::text
      and lower(coalesce(to_jsonb(pa)->>'is_active', 'true')) in ('true', 't', '1')
      and (
        lower(coalesce(pmg.status, '')) in ('final', 'posted', 'reconciled')
        or lower(coalesce(to_jsonb(pa)->>'status', '')) in ('final', 'posted', 'reconciled')
        or lower(coalesce(to_jsonb(bm)->>'status', '')) in ('final', 'posted')
      )
  ), 0)
`;

function parseInvoiceId(req: Request): number | null {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseCompanyId(req: Request): number | null {
  const raw = first(req.query.company) ?? first(req.query.companyId) ?? first(req.query.company_id);
  const sessionCompanyId = getLocalApiUser(req)?.companyId ?? null;
  if (!raw || raw === "all") return sessionCompanyId;
  const companyId = Number(raw);
  if (!Number.isInteger(companyId) || companyId <= 0) return null;
  if (sessionCompanyId !== null && sessionCompanyId !== companyId) return null;
  return companyId;
}

function invoiceResponse(row: {
  id: number;
  company_id: number;
  invoice_number: string;
  status: string;
  grand_total: string | number;
  reconciled_amount_paid: string | number;
  updated_at: Date | string;
}) {
  const reconciledAmountPaid = Number(row.reconciled_amount_paid);
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    companyId: row.company_id,
    status: row.status,
    grandTotal: Number(row.grand_total),
    reconciledAmountPaid: Number.isFinite(reconciledAmountPaid) ? Math.max(0, reconciledAmountPaid) : 0,
    amountPaid: Number.isFinite(reconciledAmountPaid) ? Math.max(0, reconciledAmountPaid) : 0,
    updatedAt: row.updated_at,
  };
}

router.get("/purchase-workflow/vendor-invoices", async (req, res): Promise<void> => {
  const companyId = parseCompanyId(req);
  if (companyId === null) {
    sendError(res, 400, "Perusahaan invoice tidak valid", "INVALID_COMPANY");
    return;
  }
  try {
    const result = await pool.query<VendorInvoiceListRow>(`
       select vi.id, vi.invoice_number, vi.vendor_invoice_ref, vi.supplier_name,
              vi.status::text status, vi.grand_total,
             ${CANONICAL_VENDOR_INVOICE_PAID_SQL} reconciled_amount_paid,
             vi.three_way_match_status, vi.company_id, vi.invoice_date,
             vi.journal_entry_id, ae.status::text journal_status
      from public.vendor_invoices vi
      left join public.accounting_entries ae on ae.id = vi.journal_entry_id
      where vi.company_id = $1
      order by vi.created_at desc, vi.id desc
    `, [companyId]);
    res.json(result.rows.map((row) => ({
      id: row.id,
      invoiceNumber: row.invoice_number,
      vendorInvoiceRef: row.vendor_invoice_ref,
      supplierName: row.supplier_name,
      status: row.status,
      grandTotal: Number(row.grand_total),
      reconciledAmountPaid: Number(row.reconciled_amount_paid),
      amountPaid: Number(row.reconciled_amount_paid),
      threeWayMatchStatus: row.three_way_match_status,
      companyId: row.company_id,
      invoiceDate: row.invoice_date,
      journalStatus: row.journal_status,
    })));
  } catch (error) {
    req.log.error({ error }, "Failed to load vendor invoices from Supabase");
    sendError(res, 503, "Data vendor invoice tidak dapat dimuat", "VENDOR_INVOICE_LOAD_FAILED");
  }
});

router.get("/purchase-workflow/vendor-invoices/liability-accounts", async (req, res): Promise<void> => {
  const companyId = parseCompanyId(req);
  if (companyId === null) {
    sendError(res, 400, "Perusahaan invoice tidak valid", "INVALID_COMPANY");
    return;
  }
  try {
    const result = await pool.query<LiabilityAccountRow>(`
      select id, code, name
      from public.chart_of_accounts
      where coalesce(is_active, true) = true
        and (company_id = $1 or company_id is null)
        and lower(coalesce(account_type::text, type::text, '')) = 'liability'
      order by code, id
    `, [companyId]);
    res.json(result.rows);
  } catch (error) {
    req.log.error({ error }, "Failed to load liability accounts from Supabase");
    sendError(res, 503, "Akun liabilitas tidak dapat dimuat", "LIABILITY_ACCOUNT_LOAD_FAILED");
  }
});

router.get("/purchase-workflow/vendor-invoices/:id", async (req, res): Promise<void> => {
  const invoiceId = parseInvoiceId(req);
  const companyId = parseCompanyId(req);
  if (invoiceId === null) {
    sendError(res, 400, "ID invoice tidak valid", "INVALID_INVOICE_ID");
    return;
  }
  if (companyId === null) {
    sendError(res, 400, "Perusahaan invoice tidak valid", "INVALID_COMPANY");
    return;
  }
  try {
    const invoiceResult = await pool.query<VendorInvoiceDetailRow>(`
      select vi.*, vi.status::text status,
             ${CANONICAL_VENDOR_INVOICE_PAID_SQL} reconciled_amount_paid,
             ae.status::text journal_status, ae.entry_number journal_entry_number
      from public.vendor_invoices vi
      left join public.accounting_entries ae on ae.id = vi.journal_entry_id
      where vi.id = $1 and vi.company_id = $2
    `, [invoiceId, companyId]);
    const row = invoiceResult.rows[0];
    if (!row) {
      sendError(res, 404, "Invoice tidak ditemukan", "INVOICE_NOT_FOUND");
      return;
    }
    const [lines, taxes, withholding] = await Promise.all([
      pool.query<VendorInvoiceLineRow>(`
        select id, product_id product_id, name, quantity, unit, unit_cost unit_cost,
               subtotal, tax_amount tax_amount, notes, coa_account_id coa_account_id
        from public.vendor_invoice_lines
        where invoice_id = $1
        order by id
      `, [invoiceId]),
      pool.query<VendorInvoiceLineTaxRow>(`
        select id, invoice_line_id invoice_line_id, tax_type tax_type, tax_object tax_object,
               tax_amount tax_amount, liability_account_id liability_account_id,
               resolution_status resolution_status
        from public.vendor_invoice_line_taxes
        where invoice_line_id in (
          select id from public.vendor_invoice_lines where invoice_id = $1
        )
        order by id
      `, [invoiceId]),
      pool.query<VendorWithholdingRecordRow>(`
        select id, vendor_invoice_id vendor_invoice_id, invoice_line_id invoice_line_id,
               line_tax_id line_tax_id, tax_type tax_type, tax_object tax_object,
               tax_amount tax_amount, liability_account_id liability_account_id, status
        from public.vendor_withholding_records
        where vendor_invoice_id = $1
        order by id
      `, [invoiceId]),
    ]);
    res.json({
      id: row.id,
      invoiceNumber: row.invoice_number,
      vendorInvoiceRef: row.vendor_invoice_ref,
      companyId: row.company_id,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      poId: row.po_id,
      grId: row.gr_id,
      status: row.status,
      invoiceDate: row.invoice_date,
      dueDate: row.due_date,
      paymentTermDays: row.payment_term_days,
      totalAmount: row.total_amount,
      taxAmount: row.tax_amount,
      grandTotal: row.grand_total,
      reconciledAmountPaid: row.reconciled_amount_paid,
      amountPaid: row.reconciled_amount_paid,
      threeWayMatchStatus: row.three_way_match_status,
      matchNotes: row.match_notes,
      journalEntryId: row.journal_entry_id,
      journalStatus: row.journal_status,
      journalEntryNumber: row.journal_entry_number,
      withholdingTaxAmount: row.withholding_tax_amount,
      withholdingTaxType: row.withholding_tax_type,
      invoiceBreakdown: row.invoice_breakdown,
      lines: lines.rows,
      lineTaxes: taxes.rows,
      withholdingRecords: withholding.rows,
    });
  } catch (error) {
    req.log.error({ error, invoiceId }, "Failed to load vendor invoice from Supabase");
    sendError(res, 503, "Detail vendor invoice tidak dapat dimuat", "VENDOR_INVOICE_DETAIL_FAILED");
  }
});

router.post("/purchase-workflow/vendor-invoices/:id/reset-payment", async (req, res): Promise<void> => {
  const invoiceId = parseInvoiceId(req);
  if (invoiceId === null) {
    sendError(res, 400, "ID invoice tidak valid", "INVALID_INVOICE_ID");
    return;
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (reason.length < 10) {
    sendError(res, 400, "Alasan koreksi minimal 10 karakter", "INVALID_RESET_REASON");
    return;
  }

  const companyId = parseCompanyId(req);
  if (companyId === null) {
    sendError(res, 400, "Perusahaan invoice tidak valid", "INVALID_COMPANY");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const invoiceResult = await client.query<{
      id: number;
      company_id: number;
      supplier_id: number | null;
      invoice_number: string;
      status: string;
      grand_total: string;
      amount_paid: string;
      updated_at: Date;
    }>(
      `select id, company_id, supplier_id, invoice_number, status::text status,
              grand_total, amount_paid, updated_at
       from public.vendor_invoices
       where id = $1 and company_id = $2
       for update`,
      [invoiceId, companyId],
    );
    const invoice = invoiceResult.rows[0];
    if (!invoice) {
      await client.query("rollback");
      sendError(res, 404, "Invoice tidak ditemukan", "INVOICE_NOT_FOUND");
      return;
    }

    const activeSettlement = await client.query<{
      allocation_id: number;
      group_id: number;
      group_status: string;
      mutation_id: number | null;
      payment_id: number | null;
    }>(
      `select pa.id allocation_id, pa.group_id, pmg.status group_status,
              pa.mutation_id, pa.payment_id
       from public.payment_allocations pa
       join public.payment_matching_groups pmg on pmg.id = pa.group_id
       where pa.invoice_id = $1
         and pa.company_id = $2
         and coalesce(pa.is_active, true) = true
         and lower(coalesce(pmg.status, '')) in ('final', 'posted', 'reconciled')
       order by pa.id
       limit 1`,
      [invoiceId, companyId],
    );
    if (activeSettlement.rows[0]) {
      const settlement = activeSettlement.rows[0];
      await client.query("rollback");
      sendError(
        res,
        409,
        "Pembayaran tidak dapat di-reset karena masih terhubung ke settlement yang sudah posted atau reconciled",
        "ACTIVE_SETTLEMENT",
        {
          allocationId: settlement.allocation_id,
          groupId: settlement.group_id,
          settlementStatus: settlement.group_status,
          paymentId: settlement.payment_id,
          mutationId: settlement.mutation_id,
        },
      );
      return;
    }

    const before = {
      status: invoice.status,
      amountPaid: Number(invoice.amount_paid),
      updatedAt: invoice.updated_at,
    };
    const updated = await client.query<{
      id: number;
      company_id: number;
      invoice_number: string;
      status: string;
      grand_total: string;
      amount_paid: string;
      reconciled_amount_paid: string;
      updated_at: Date;
    }>(
      `update public.vendor_invoices
       set amount_paid = 0,
           status = case when status::text = 'paid' then 'posted' else status end,
           updated_at = now()
       where id = $1 and company_id = $2
       returning id, company_id, invoice_number, status::text status,
                 grand_total, amount_paid, 0::numeric reconciled_amount_paid, updated_at`,
      [invoiceId, companyId],
    );
    const nextInvoice = updated.rows[0];

    await client.query(
      `insert into public.audit_logs
        (user_id, user_email, action, entity_type, entity_id, before_data, after_data,
         user_agent, created_at, company_id, module)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, now(), $9, $10)`,
      [
        null,
        getLocalApiUser(req)?.email ?? "local-admin",
        "reset_payment",
        "vendor_invoice",
        String(invoiceId),
        JSON.stringify({ ...before, reason }),
        JSON.stringify({
          status: nextInvoice.status,
          amountPaid: Number(nextInvoice.amount_paid),
          reason,
        }),
        req.get("user-agent") ?? null,
        companyId,
        "purchase",
      ],
    );

    await client.query("commit");
    res.json({
      ok: true,
      invoiceId,
      paymentStatus: {
        status: "unpaid",
        amountPaid: 0,
      },
      invoice: invoiceResponse(nextInvoice),
    });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    req.log.error({ error, invoiceId }, "Failed to reset vendor invoice payment");
    sendError(res, 503, "Reset pembayaran tidak dapat diproses", "RESET_PAYMENT_FAILED");
  } finally {
    client.release();
  }
});

export default router;