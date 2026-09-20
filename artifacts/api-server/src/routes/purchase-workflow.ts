import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getDevSession, getProductionSession, isDevelopmentEnvironment, type DevAuthUser } from "./dev-auth";

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
  withholding_tax_amount: string | null;
  withholding_tax_type: string | null;
  invoice_breakdown: unknown;
  pph_paid_amount: string;
  total_count: number;
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

interface LegacyRepairInvoiceRow {
  id: number;
  invoice_number: string;
  supplier_name: string | null;
  status: string;
  grand_total: string;
  total_amount: string;
  withholding_tax_amount: string | null;
  withholding_tax_type: string | null;
  tax_object: string | null;
  invoice_breakdown: unknown;
  created_at: Date | string;
}

interface LegacyRepairTaxRow {
  id: number;
  invoice_line_id: number;
  tax_type: string;
  tax_object: string;
  base_amount: string;
  tax_amount: string;
  liability_account_id: number | null;
  resolution_status: string | null;
}

interface LegacyRepairPlan {
  invoiceLineId: number;
  taxType: string;
  taxObject: string;
  baseAmount: number;
  taxAmount: number;
  liabilityAccountId: number | null;
}

type LegacyRepairComponent = Omit<LegacyRepairPlan, "invoiceLineId"> & {
  invoiceLineId?: number;
};

interface LegacyRepairRequestRow {
  invoiceLineId: number;
  taxType: string;
  taxObject: string;
  baseAmount: number;
  taxAmount: number;
  liabilityAccountId: number;
}

interface LegacyRepairAuditDbRow {
  id: number;
  user_email: string | null;
  created_at: Date | string;
  before_data: unknown;
  after_data: unknown;
}

interface LegacyRepairAuditTaxRow {
  invoiceLineId: number | null;
  taxType: string;
  taxObject: string;
  baseAmount: number;
  taxAmount: number;
  liabilityAccountId: number | null;
  lineTaxId: number | null;
  resolutionStatus: string | null;
}

function getLocalApiUser(req: Request): DevAuthUser | null {
  const devUser = getDevSession(req);
  if (devUser) return devUser;
  if (isDevelopmentEnvironment()) return null;
  return null;
}

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

// CST-BIZPORTAL is standalone: vendor-invoice requests stay in this router.
// Unknown vendor-invoice endpoints naturally fall through to the API 404 after
// local route matching; do not escape this router with next("router").

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

function finiteMoney(value: unknown): number {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positiveIntegerOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function auditTaxRows(value: unknown): LegacyRepairAuditTaxRow[] {
  const rows = objectValue(value).rows;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((raw) => {
    const row = objectValue(raw);
    const taxType = String(row.taxType ?? row.tax_type ?? "").trim();
    const taxObject = String(row.taxObject ?? row.tax_object ?? "").trim();
    const taxAmount = finiteMoney(row.taxAmount ?? row.tax_amount);
    if (!taxType && !taxObject && taxAmount <= 0) return [];
    return [{
      invoiceLineId: positiveIntegerOrNull(row.invoiceLineId ?? row.invoice_line_id),
      taxType,
      taxObject,
      baseAmount: finiteMoney(row.baseAmount ?? row.base_amount),
      taxAmount,
      liabilityAccountId: positiveIntegerOrNull(row.liabilityAccountId ?? row.liability_account_id),
      lineTaxId: positiveIntegerOrNull(row.lineTaxId ?? row.line_tax_id ?? row.id),
      resolutionStatus: row.resolutionStatus == null && row.resolution_status == null
        ? null
        : String(row.resolutionStatus ?? row.resolution_status),
    }];
  });
}

function legacyRepairAuditEvent(row: LegacyRepairAuditDbRow) {
  const beforeData = objectValue(row.before_data);
  const afterData = objectValue(row.after_data);
  const reason = String(afterData.reason ?? beforeData.reason ?? "").trim();
  return {
    id: row.id,
    actor: row.user_email,
    timestamp: row.created_at,
    reason,
    beforeRows: auditTaxRows(row.before_data),
    afterRows: auditTaxRows(row.after_data),
  };
}

export function legacyRepairComponents(invoice: LegacyRepairInvoiceRow): LegacyRepairComponent[] {
  const breakdown = objectValue(invoice.invoice_breakdown);
  const repairedComponents = Array.isArray(breakdown.withholding_repair_components)
    ? breakdown.withholding_repair_components
    : [];
  if (repairedComponents.length > 0) {
    return repairedComponents.flatMap((raw) => {
      const component = objectValue(raw);
      const taxAmount = finiteMoney(component.tax_amount);
      const taxType = String(component.tax_type ?? "").trim();
      const taxObject = String(component.tax_object ?? "").trim();
      if (taxAmount <= 0 || !taxType || !taxObject) return [];
      return [{
        invoiceLineId: Number.isInteger(Number(component.invoice_line_id))
          ? Number(component.invoice_line_id)
          : undefined,
        taxType,
        taxObject,
        baseAmount: finiteMoney(component.base_amount),
        taxAmount,
        liabilityAccountId: Number.isInteger(Number(component.liability_account_id))
          ? Number(component.liability_account_id)
          : null,
      }];
    });
  }
  const components = Array.isArray(breakdown.components) ? breakdown.components : [];
  const plans = components.flatMap((raw, index) => {
    const component = objectValue(raw);
    const taxAmount = finiteMoney(component.withholding_tax_amount);
    const taxType = String(component.withholding_tax_type ?? "").trim();
    if (taxAmount <= 0 || !taxType) return [];
    return [{
      taxType,
      taxObject: String(
        component.tax_object ?? component.component ?? component.label ?? `component_${index + 1}`,
      ).trim(),
      baseAmount: finiteMoney(component.dpp ?? component.base_amount),
      taxAmount,
      liabilityAccountId: null,
    }];
  });
  if (plans.length > 0) return plans;
  const taxAmount = finiteMoney(invoice.withholding_tax_amount);
  if (taxAmount <= 0) return [];
  return [{
    taxType: String(invoice.withholding_tax_type ?? "PPh").trim() || "PPh",
    taxObject: String(invoice.tax_object ?? "legacy_invoice_header").trim() || "legacy_invoice_header",
    baseAmount: finiteMoney(invoice.total_amount),
    taxAmount,
    liabilityAccountId: null,
  }];
}

export function repairReason(
  plans: LegacyRepairPlan[],
  taxes: LegacyRepairTaxRow[],
): { code: string; message: string } | null {
  if (plans.some((plan) => /\s+\+\s+/.test(plan.taxType))) {
    return {
      code: "COMBINED_VENDOR_WITHHOLDING_ROW",
      message: "Header PPh masih menggabungkan beberapa jenis pajak dan harus dipisahkan.",
    };
  }
  if (plans.some((plan) => !plan.taxObject)) {
    return { code: "INVALID_TAX_OBJECT", message: "Satu atau lebih komponen PPh belum memiliki tax object." };
  }
  const expected = new Map(plans.map((plan) => [
    `${plan.invoiceLineId}\u0000${plan.taxType}\u0000${plan.taxObject}\u0000${plan.taxAmount}`,
    plan,
  ]));
  const actualKeys = taxes.map((tax) =>
    `${tax.invoice_line_id}\u0000${tax.tax_type.trim()}\u0000${tax.tax_object.trim()}\u0000${finiteMoney(tax.tax_amount)}`);
  if (
    taxes.some((tax) => /\s+\+\s+/.test(tax.tax_type))
    || actualKeys.length !== expected.size
    || new Set(actualKeys).size !== actualKeys.length
    || actualKeys.some((key) => !expected.has(key))
  ) {
    return {
      code: "INCONSISTENT_VENDOR_WITHHOLDING_ROWS",
      message: "Baris PPh tersimpan tidak sesuai rincian jenis, tax object, atau nominal invoice.",
    };
  }
  if (taxes.some((tax) => !tax.liability_account_id || !["confirmed", "approved"].includes(String(tax.resolution_status)))) {
    return {
      code: "WITHHOLDING_LIABILITY_ACCOUNT_REQUIRED",
      message: "Satu atau lebih baris PPh belum dipetakan ke COA liabilitas aktif.",
    };
  }
  return null;
}

async function loadLegacyRepairData(
  query: typeof pool.query,
  companyId: number,
  invoiceId?: number,
): Promise<Array<{
  invoice: LegacyRepairInvoiceRow;
  lines: Array<{ id: number }>;
  taxes: LegacyRepairTaxRow[];
  plans: LegacyRepairPlan[];
  reason: { code: string; message: string } | null;
}>> {
  const invoiceResult = await query<LegacyRepairInvoiceRow>(
    `select id, invoice_number, supplier_name, status::text status, grand_total, total_amount,
            withholding_tax_amount, withholding_tax_type, tax_object, invoice_breakdown, created_at
       from public.vendor_invoices
      where company_id = $1
        and cancelled_at is null
        and ($2::bigint is null or id = $2)
        and (
          coalesce(withholding_tax_amount, 0) > 0
          or coalesce((invoice_breakdown->'totals'->>'withholding_tax_amount')::numeric, 0) > 0
          or exists (
            select 1
              from public.vendor_invoice_lines vil
              join public.vendor_invoice_line_taxes vit on vit.invoice_line_id = vil.id
             where vil.invoice_id = vendor_invoices.id
               and vit.company_id = vendor_invoices.company_id
               and vit.tax_amount > 0
          )
        )
      order by created_at desc nulls last, id desc`,
    [companyId, invoiceId ?? null],
  );
  return Promise.all(invoiceResult.rows.map(async (invoice) => {
    const [lineResult, taxResult] = await Promise.all([
      query<{ id: number }>(
        "select id from public.vendor_invoice_lines where invoice_id = $1 order by id",
        [invoice.id],
      ),
      query<LegacyRepairTaxRow>(
        `select vit.id, vit.invoice_line_id, vit.tax_type, vit.tax_object, vit.base_amount,
                vit.tax_amount, vit.liability_account_id, vit.resolution_status
           from public.vendor_invoice_line_taxes vit
           join public.vendor_invoice_lines vil on vil.id = vit.invoice_line_id
          where vil.invoice_id = $1 and vit.company_id = $2 and vit.tax_amount > 0
          order by vit.id`,
        [invoice.id, companyId],
      ),
    ]);
    const components = legacyRepairComponents(invoice);
    const firstLineId = lineResult.rows[0]?.id ?? 0;
    const plans = components.map((plan, index) => ({
      ...plan,
      invoiceLineId: plan.invoiceLineId ?? lineResult.rows[index]?.id ?? firstLineId,
      liabilityAccountId: taxResult.rows.find((tax) =>
        tax.tax_type.trim() === plan.taxType
        && tax.tax_object.trim() === plan.taxObject
        && finiteMoney(tax.tax_amount) === plan.taxAmount
      )?.liability_account_id ?? null,
    }));
    return {
      invoice,
      lines: lineResult.rows,
      taxes: taxResult.rows,
      plans,
      reason: repairReason(plans, taxResult.rows),
    };
  }));
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
    const result = await pool.query<VendorInvoiceListRow>(`
      ${RECONCILED_PAYMENT_CTE}
      select vi.id, vi.invoice_number, vi.vendor_invoice_ref, vi.supplier_name,
             vi.status::text status, vi.grand_total,
             coalesce(rvip.paid_amount, 0) reconciled_amount_paid,

             vi.three_way_match_status, vi.company_id, vi.invoice_date,
             vi.journal_entry_id, ae.status::text journal_status,
             vi.withholding_tax_amount, vi.withholding_tax_type, vi.invoice_breakdown,
             coalesce(pph_payment.paid_amount, 0) pph_paid_amount,
             count(*) over()::int total_count
        from public.vendor_invoices vi
        left join public.accounting_entries ae on ae.id = vi.journal_entry_id
        ${RECONCILED_PAYMENT_JOIN}
        left join lateral (
          select coalesce(sum(bdi.amount), 0) paid_amount
          from public.bank_disbursement_items bdi
          join public.bank_disbursements bd on bd.id = bdi.disbursement_id
          where bdi.vendor_invoice_id = vi.id
            and bdi.transaction_type = 'tax_payment'
            and bd.company_id = vi.company_id
            and bd.status = 'posted'
        ) pph_payment on true
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
        withholdingTaxAmount: row.withholding_tax_amount,
        withholdingTaxType: row.withholding_tax_type,
        invoiceBreakdown: row.invoice_breakdown,
        pphPaidAmount: Number(row.pph_paid_amount),
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

router.get("/purchase-workflow/vendor-invoices/legacy-withholding-repairs", async (req, res): Promise<void> => {
  const companyId = parseCompanyId(req);
  if (companyId === null) {
    sendError(res, 400, "Perusahaan invoice tidak valid", "INVALID_COMPANY");
    return;
  }
  try {
    const entries = (await loadLegacyRepairData(pool.query.bind(pool), companyId))
      .filter((entry) => entry.reason !== null);
    res.json({
      data: entries.map(({ invoice, plans, reason }) => ({
        id: invoice.id,
        invoiceNumber: invoice.invoice_number,
        supplierName: invoice.supplier_name,
        status: invoice.status,
        grandTotal: Number(invoice.grand_total),
        withholdingAmount: plans.reduce((sum, plan) => sum + plan.taxAmount, 0),
        reasonCode: reason!.code,
        reason: reason!.message,
        componentCount: plans.length,
      })),
      total: entries.length,
    });
  } catch (error) {
    req.log.error({ error }, "Failed to load legacy withholding repair queue");
    sendError(res, 503, "Daftar perbaikan PPh tidak dapat dimuat", "LEGACY_WITHHOLDING_REPAIR_LOAD_FAILED");
  }
});

router.get("/purchase-workflow/vendor-invoices/:id/legacy-withholding-repair", async (req, res): Promise<void> => {
  const invoiceId = parseInvoiceId(req);
  const companyId = parseCompanyId(req);
  if (invoiceId === null || companyId === null) {
    sendError(res, 400, "Invoice atau perusahaan tidak valid", "INVALID_REPAIR_TARGET");
    return;
  }
  try {
    const entry = (await loadLegacyRepairData(pool.query.bind(pool), companyId, invoiceId))[0];
    if (!entry) {
      sendError(res, 404, "Invoice PPh tidak ditemukan", "INVOICE_NOT_FOUND");
      return;
    }
    if (!entry.reason) {
      res.json({ repairRequired: false, invoiceId, rows: [] });
      return;
    }
    res.json({
      repairRequired: true,
      invoiceId,
      invoiceNumber: entry.invoice.invoice_number,
      supplierName: entry.invoice.supplier_name,
      grandTotal: Number(entry.invoice.grand_total),
      reasonCode: entry.reason.code,
      reason: entry.reason.message,
      rows: entry.plans,
    });
  } catch (error) {
    req.log.error({ error, invoiceId }, "Failed to preview legacy withholding repair");
    sendError(res, 503, "Preview perbaikan PPh tidak dapat dimuat", "LEGACY_WITHHOLDING_REPAIR_PREVIEW_FAILED");
  }
});

router.get("/purchase-workflow/vendor-invoices/:id/legacy-withholding-repair-history", async (req, res): Promise<void> => {
  const invoiceId = parseInvoiceId(req);
  const companyId = parseCompanyId(req);
  if (invoiceId === null || companyId === null) {
    sendError(res, 400, "Invoice atau perusahaan tidak valid", "INVALID_REPAIR_HISTORY_TARGET");
    return;
  }
  try {
    const result = await pool.query<LegacyRepairAuditDbRow>(
      `select id, user_email, created_at, before_data, after_data
         from public.audit_logs
        where company_id = $1
          and entity_type = 'vendor_invoice'
          and entity_id = $2
          and action = 'repair_legacy_withholding'
        order by created_at desc nulls last, id desc`,
      [companyId, String(invoiceId)],
    );
    res.json({
      data: result.rows.map(legacyRepairAuditEvent),
      total: result.rows.length,
    });
  } catch (error) {
    req.log.error({ error, invoiceId }, "Failed to load legacy withholding repair history");
    sendError(
      res,
      503,
      "Riwayat perbaikan PPh tidak dapat dimuat",
      "LEGACY_WITHHOLDING_REPAIR_HISTORY_FAILED",
    );
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
         and coalesce(is_postable, true) = true
         and coalesce(status::text, 'ACTIVE') = 'ACTIVE'
         and company_id = $1
        and (
          lower(coalesce(account_type::text, '')) = 'liability'
          or lower(coalesce(type::text, '')) = 'liability'
        )
      order by code, id
    `, [companyId]);
    res.json(result.rows);
  } catch (error) {
    req.log.error({ error }, "Failed to load liability accounts from Supabase");
    sendError(res, 503, "Akun liabilitas tidak dapat dimuat", "LIABILITY_ACCOUNT_LOAD_FAILED");
  }
});

router.post("/purchase-workflow/vendor-invoices/:id/legacy-withholding-repair", async (req, res): Promise<void> => {
  const invoiceId = parseInvoiceId(req);
  const companyId = parseCompanyId(req);
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const idempotencyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey.trim() : "";
  const requestedRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (invoiceId === null || companyId === null) {
    sendError(res, 400, "Invoice atau perusahaan tidak valid", "INVALID_REPAIR_TARGET");
    return;
  }
  if (reason.length < 10 || idempotencyKey.length < 8 || idempotencyKey.length > 120) {
    sendError(res, 400, "Alasan minimal 10 karakter dan kunci idempotensi wajib diisi", "INVALID_REPAIR_REQUEST");
    return;
  }
  const rows: LegacyRepairRequestRow[] = requestedRows.map((value: unknown): LegacyRepairRequestRow => {
    const row = objectValue(value);
    return {
      invoiceLineId: Number(row.invoiceLineId),
      taxType: String(row.taxType ?? "").trim(),
      taxObject: String(row.taxObject ?? "").trim(),
      baseAmount: finiteMoney(row.baseAmount),
      taxAmount: finiteMoney(row.taxAmount),
      liabilityAccountId: Number(row.liabilityAccountId),
    };
  });
  if (
    rows.length === 0
    || rows.some((row) =>
      !Number.isInteger(row.invoiceLineId) || row.invoiceLineId <= 0
      || !row.taxType || /\s+\+\s+/.test(row.taxType) || !row.taxObject
      || row.baseAmount < 0 || row.taxAmount <= 0
      || !Number.isInteger(row.liabilityAccountId) || row.liabilityAccountId <= 0)
    || new Set(rows.map((row) => `${row.invoiceLineId}\u0000${row.taxType}\u0000${row.taxObject}`)).size !== rows.length
  ) {
    sendError(res, 400, "Setiap baris PPh harus terpisah dan memiliki line, jenis, tax object, nominal, serta COA yang valid", "INVALID_REPAIR_ROWS");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${companyId}:vendor-invoice:${invoiceId}:legacy-withholding-repair`,
    ]);
    const lockedInvoice = await client.query<{ id: number }>(
      "select id from public.vendor_invoices where id = $1 and company_id = $2 for update",
      [invoiceId, companyId],
    );
    if (!lockedInvoice.rows[0]) {
      await client.query("rollback");
      sendError(res, 404, "Invoice PPh tidak ditemukan", "INVOICE_NOT_FOUND");
      return;
    }
    const prior = await client.query<{ after_data: Record<string, unknown> }>(
      `select after_data from public.audit_logs
        where company_id = $1 and entity_type = 'vendor_invoice' and entity_id = $2
          and action = 'repair_legacy_withholding'
          and after_data->>'idempotencyKey' = $3
        order by created_at desc limit 1`,
      [companyId, String(invoiceId), idempotencyKey],
    );
    if (prior.rows[0]) {
      const priorRows = Array.isArray(prior.rows[0].after_data.rows) ? prior.rows[0].after_data.rows : [];
      if (JSON.stringify(priorRows) !== JSON.stringify(rows)) {
        await client.query("rollback");
        sendError(res, 409, "Kunci idempotensi sudah digunakan dengan isi berbeda", "IDEMPOTENCY_CONFLICT");
        return;
      }
      await client.query("commit");
      res.json({ ok: true, invoiceId, rows: priorRows, idempotent: true });
      return;
    }
    const entry = (await loadLegacyRepairData(client.query.bind(client), companyId, invoiceId))[0];
    if (!entry) {
      await client.query("rollback");
      sendError(res, 404, "Invoice PPh tidak ditemukan", "INVOICE_NOT_FOUND");
      return;
    }
    if (!entry.reason) {
      await client.query("rollback");
      sendError(res, 409, "Rincian PPh invoice ini sudah konsisten dan tidak perlu diperbaiki lagi", "REPAIR_NOT_REQUIRED");
      return;
    }
    const lineIds = new Set(entry.lines.map((line) => line.id));
    if (rows.some((row) => !lineIds.has(row.invoiceLineId))) {
      await client.query("rollback");
      sendError(res, 400, "Satu atau lebih line tidak berasal dari invoice ini", "INVOICE_LINE_MISMATCH");
      return;
    }
    const expected = entry.plans.map((plan) => ({
      invoiceLineId: plan.invoiceLineId,
      taxType: plan.taxType,
      taxObject: plan.taxObject,
      baseAmount: plan.baseAmount,
      taxAmount: plan.taxAmount,
    }));
    const comparable = (value: typeof expected[number]) =>
      `${value.invoiceLineId}\u0000${value.taxType}\u0000${value.taxObject}\u0000${value.baseAmount}\u0000${value.taxAmount}`;
    const combinedSource = expected.some((plan) => /\s+\+\s+/.test(plan.taxType));
    const expectedTaxTotal = finiteMoney(expected.reduce((sum, plan) => sum + plan.taxAmount, 0));
    const requestedTaxTotal = finiteMoney(rows.reduce((sum, row) => sum + row.taxAmount, 0));
    const expectedTaxCents = Math.round(expectedTaxTotal * 100);
    const requestedTaxCents = Math.round(requestedTaxTotal * 100);
    const exactBreakdownMatch = rows.length === expected.length
      && new Set(rows.map(comparable)).size === expected.length
      && rows.every((row) => expected.some((plan) => comparable(plan) === comparable(row)));
    if (
      expectedTaxCents !== requestedTaxCents
      || (!combinedSource && !exactBreakdownMatch)
    ) {
      await client.query("rollback");
      sendError(
        res,
        409,
        "Total PPh atau rincian perbaikan tidak lagi sesuai dengan breakdown invoice terbaru",
        "REPAIR_PREVIEW_STALE",
        { expectedTaxTotal, requestedTaxTotal },
      );
      return;
    }
    const accountIds = [...new Set(rows.map((row) => row.liabilityAccountId))];
    const accounts = await client.query<{ id: number }>(
      `select id from public.chart_of_accounts
        where company_id = $1 and id = any($2::bigint[])
          and coalesce(is_active, true) = true and coalesce(is_postable, true) = true
          and coalesce(status::text, 'ACTIVE') = 'ACTIVE'
          and (lower(coalesce(account_type::text, '')) = 'liability'
            or lower(coalesce(type::text, '')) = 'liability')
        for update`,
      [companyId, accountIds],
    );
    if (accounts.rows.length !== accountIds.length) {
      await client.query("rollback");
      sendError(res, 400, "COA liabilitas harus aktif, postable, dan berasal dari company aktif", "LIABILITY_ACCOUNT_NOT_FOUND");
      return;
    }
    const before = entry.taxes;
    await client.query(
      `delete from public.vendor_withholding_records
        where company_id = $1 and vendor_invoice_id = $2
          and coalesce(status::text, 'proof_pending') not in ('proof_received', 'posted')`,
      [companyId, invoiceId],
    );
    const protectedRows = await client.query<{ id: number }>(
      `select id from public.vendor_withholding_records
        where company_id = $1 and vendor_invoice_id = $2
          and status::text in ('proof_received', 'posted') limit 1`,
      [companyId, invoiceId],
    );
    if (protectedRows.rows[0]) {
      await client.query("rollback");
      sendError(res, 409, "Perbaikan ditolak karena bukti potong sudah diterima atau diposting", "WITHHOLDING_ALREADY_FINAL");
      return;
    }
    await client.query(
      `delete from public.vendor_invoice_line_taxes
        where company_id = $1 and invoice_line_id = any($2::bigint[])`,
      [companyId, [...lineIds]],
    );
    const savedRows: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const inserted = await client.query<{ id: number }>(
        `insert into public.vendor_invoice_line_taxes
          (invoice_line_id, company_id, tax_type, tax_object, base_amount, tax_amount,
           liability_account_id, resolution_status, reviewed_by, reviewed_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8, now())
         returning id`,
        [row.invoiceLineId, companyId, row.taxType, row.taxObject, row.baseAmount, row.taxAmount,
          row.liabilityAccountId, (req as PurchaseRequest).purchaseUser?.email ?? "ADMIN"],
      );
      const lineTaxId = inserted.rows[0].id;
      await client.query(
        `insert into public.vendor_withholding_records
          (company_id, vendor_invoice_id, invoice_line_id, line_tax_id, tax_type, tax_object,
           base_amount, tax_amount, liability_account_id, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'proof_pending')`,
        [companyId, invoiceId, row.invoiceLineId, lineTaxId, row.taxType, row.taxObject,
          row.baseAmount, row.taxAmount, row.liabilityAccountId],
      );
      savedRows.push({ ...row, lineTaxId });
    }
    const canonicalRepairComponents = rows.map((row) => ({
      invoice_line_id: row.invoiceLineId,
      tax_type: row.taxType,
      tax_object: row.taxObject,
      base_amount: row.baseAmount,
      tax_amount: row.taxAmount,
      liability_account_id: row.liabilityAccountId,
      resolution_status: "confirmed",
    }));
    await client.query(
      `update public.vendor_invoices
          set withholding_review_status = 'required',
              invoice_breakdown = jsonb_set(
                coalesce(invoice_breakdown, '{}'::jsonb),
                '{withholding_repair_components}',
                $3::jsonb,
                true
              ),
              updated_at = now()
        where id = $1 and company_id = $2`,
      [invoiceId, companyId, JSON.stringify(canonicalRepairComponents)],
    );
    await client.query(
      `insert into public.audit_logs
        (user_id, user_email, action, entity_type, entity_id, before_data, after_data,
         user_agent, created_at, company_id, module)
       values ($1, $2, 'repair_legacy_withholding', 'vendor_invoice', $3, $4::jsonb, $5::jsonb,
               $6, now(), $7, 'purchase')`,
      [null, (req as PurchaseRequest).purchaseUser?.email ?? "unknown-admin", String(invoiceId),
        JSON.stringify({ reason, rows: before }),
        JSON.stringify({ reason, idempotencyKey, rows, savedRows }),
        req.get("user-agent") ?? null, companyId],
    );
    await client.query("commit");
    res.json({ ok: true, invoiceId, rows: savedRows, idempotent: false });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    req.log.error({ error, invoiceId }, "Failed to repair legacy withholding");
    sendError(res, 503, "Perbaikan PPh tidak dapat diproses", "LEGACY_WITHHOLDING_REPAIR_FAILED");
  } finally {
    client.release();
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