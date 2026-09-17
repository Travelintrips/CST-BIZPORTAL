import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getDevSession, getProductionSession, isDevelopmentEnvironment, type DevAuthUser } from "./dev-auth";

const router: IRouter = Router();

type PurchaseRequest = Request & { purchaseUser?: DevAuthUser };

async function authenticatePurchaseUser(
  req: PurchaseRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (isDevelopmentEnvironment()) {
    const user = getDevSession(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (user.role.toLowerCase() !== "admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    req.purchaseUser = user;
    next();
    return;
  }

  const session = getProductionSession(req);
  if (!session) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const result = await pool.query<{
      user_data: Record<string, unknown>;
    }>(
      `select to_jsonb(u) user_data
       from public.users u
       where lower(coalesce(to_jsonb(u)->>'email', '')) = $1
       limit 1`,
      [session.email],
    );
    const userData = result.rows[0]?.user_data;
    if (!userData) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const email = typeof userData.email === "string" ? userData.email.trim().toLowerCase() : "";
    const role = typeof userData.role === "string" ? userData.role.trim().toLowerCase() : "";
    if (email !== session.email || role !== "admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const rawCompanyId = userData.company_id ?? userData.companyId;
    const parsedCompanyId = rawCompanyId === null || rawCompanyId === undefined
      ? null
      : Number(rawCompanyId);
    req.purchaseUser = {
      id: session.id,
      email,
      firstName: typeof userData.first_name === "string" ? userData.first_name : null,
      lastName: typeof userData.last_name === "string" ? userData.last_name : null,
      role,
      companyId: parsedCompanyId !== null && Number.isInteger(parsedCompanyId) && parsedCompanyId > 0
        ? parsedCompanyId
        : null,
    };
    next();
  } catch (error) {
    req.log.error({ error }, "Failed to authorize purchase user");
    res.status(503).json({ error: "Authorization service unavailable" });
  }
}

router.use("/purchase-workflow", authenticatePurchaseUser);

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
 * Keep the compatibility reads for upstream schema revisions, but aggregate
 * them once per request instead of running a correlated subquery for every
 * invoice row.
 */
const RECONCILED_PAYMENT_CTE = `
  with reconciled_vendor_invoice_payments as (
    select
      coalesce(
        nullif(to_jsonb(pa)->>'vendor_invoice_id', ''),
        nullif(to_jsonb(pa)->>'invoice_id', '')
      )::bigint as invoice_id,
      nullif(to_jsonb(pa)->>'company_id', '')::bigint as company_id,
      sum(
        coalesce(
          nullif(to_jsonb(pa)->>'amount', '')::numeric,
          nullif(to_jsonb(pa)->>'allocated_amount', '')::numeric,
          nullif(to_jsonb(pa)->>'allocation_amount', '')::numeric,
          0
        )
      ) as paid_amount
    from public.payment_allocations pa
    left join public.payment_matching_groups pmg
      on pmg.id = nullif(to_jsonb(pa)->>'group_id', '')::bigint
    left join public.bank_mutations bm
      on bm.id = nullif(to_jsonb(pa)->>'mutation_id', '')::bigint
    where nullif(to_jsonb(pa)->>'company_id', '')::bigint = $1
      and lower(coalesce(to_jsonb(pa)->>'is_active', 'true')) in ('true', 't', '1')
      and (
        lower(coalesce(pmg.status, '')) in ('final', 'posted', 'reconciled')
        or lower(coalesce(to_jsonb(pa)->>'status', '')) in ('final', 'posted', 'reconciled')
        or lower(coalesce(to_jsonb(bm)->>'status', '')) in ('final', 'posted')
      )
    group by 1, 2
  )
`;

const RECONCILED_PAYMENT_JOIN = `
  left join reconciled_vendor_invoice_payments rvip
    on rvip.invoice_id = vi.id
   and rvip.company_id = vi.company_id
`;

function parsePositiveQueryInt(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(first(value));
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function parseInvoiceId(req: Request): number | null {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseCompanyId(req: PurchaseRequest): number | null {
  const raw = first(req.query.company) ?? first(req.query.companyId) ?? first(req.query.company_id);
  const sessionCompanyId = req.purchaseUser?.companyId ?? null;
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
  const pageSize = parsePositiveQueryInt(req.query.pageSize ?? req.query.limit, 50, 100);
  const page = parsePositiveQueryInt(req.query.page, 1, 10_000);
  const offset = (page - 1) * pageSize;
  try {
    const result = await pool.query(`
      ${RECONCILED_PAYMENT_CTE}
      select vi.id, vi.invoice_number, vi.vendor_invoice_ref, vi.supplier_name,
             vi.status::text status, vi.grand_total,
             coalesce(rvip.paid_amount, 0) reconciled_amount_paid,
             vi.three_way_match_status, vi.company_id, vi.invoice_date,
             vi.journal_entry_id, ae.status::text journal_status,
             count(*) over()::int total_count
        from public.vendor_invoices vi
        left join public.accounting_entries ae on ae.id = vi.journal_entry_id
        ${RECONCILED_PAYMENT_JOIN}
       where vi.company_id = $1
       order by vi.created_at desc nulls last, vi.id desc
       limit $2 offset $3
    `, [companyId, pageSize, offset]);
    const total = result.rows[0]?.total_count ?? 0;
    res.json({
      data: result.rows.map((row) => ({
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
      })),
      page,
      pageSize,
      total,
      hasMore: offset + result.rows.length < total,
    });
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
    const result = await pool.query(`
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
    const invoiceResult = await pool.query(`
      ${RECONCILED_PAYMENT_CTE}
      select vi.*, vi.status::text status,
              coalesce(rvip.paid_amount, 0) reconciled_amount_paid,
             ae.status::text journal_status, ae.entry_number journal_entry_number
      from public.vendor_invoices vi
      left join public.accounting_entries ae on ae.id = vi.journal_entry_id
       ${RECONCILED_PAYMENT_JOIN}
       where vi.id = $2 and vi.company_id = $1
    `, [companyId, invoiceId]);
    const row = invoiceResult.rows[0];
    if (!row) {
      sendError(res, 404, "Invoice tidak ditemukan", "INVOICE_NOT_FOUND");
      return;
    }
    const [lines, taxes, withholding] = await Promise.all([
      pool.query(`
        select id, product_id product_id, name, quantity, unit, unit_cost unit_cost,
               subtotal, tax_amount tax_amount, notes, coa_account_id coa_account_id
        from public.vendor_invoice_lines
        where invoice_id = $1
        order by id
      `, [invoiceId]),
      pool.query(`
        select id, invoice_line_id invoice_line_id, tax_type tax_type, tax_object tax_object,
               tax_amount tax_amount, liability_account_id liability_account_id,
               resolution_status resolution_status
        from public.vendor_invoice_line_taxes
        where invoice_line_id in (
          select id from public.vendor_invoice_lines where invoice_id = $1
        )
        order by id
      `, [invoiceId]),
      pool.query(`
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
        (req as PurchaseRequest).purchaseUser?.email ?? "unknown-admin",
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