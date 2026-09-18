import { sql } from "drizzle-orm";
import { recalculateVendorInvoiceBreakdown } from "./invoiceWithholdingCalculation.js";

type SqlExecutor = {
  execute: (query: unknown) => Promise<unknown>;
};

const TERMINAL_WITHHOLDING_STATUSES = new Set(["proof_received", "posted"]);

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return (((result as { rows?: T[] } | undefined)?.rows) ?? []) as T[];
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * `not_required` is the explicit persisted state for an invoice where the
 * owner has disabled withholding.  A zero header alone is not enough to
 * classify older imports because those can still carry legacy line-tax data
 * that needs Finance Review.
 */
export function isVendorWithholdingDisabled(invoice: Record<string, unknown>): boolean {
  return money(numberValue(invoice.withholding_tax_amount)) <= 0
    && String(invoice.withholding_review_status ?? "").trim().toLowerCase() === "not_required";
}

export interface VendorWithholdingTaxPlan {
  componentIndex: number;
  invoiceLineId?: number;
  type: string;
  object: string;
  base: number;
  amount: number;
  liabilityAccountId: number | null;
}

export function vendorWithholdingTaxPlans(
  invoiceBreakdown: unknown,
  vendorName = "",
): VendorWithholdingTaxPlan[] {
  const breakdown = jsonObject(invoiceBreakdown);
  const repairedComponents = Array.isArray(breakdown.withholding_repair_components)
    ? breakdown.withholding_repair_components
    : [];
  if (repairedComponents.length > 0) {
    return repairedComponents.flatMap((raw, componentIndex) => {
      const component = jsonObject(raw);
      const amount = money(numberValue(component.tax_amount));
      const type = String(component.tax_type ?? "").trim();
      const object = String(component.tax_object ?? "").trim();
      if (amount <= 0 || !type || !object) return [];
      const liabilityAccountId = Number(component.liability_account_id);
      return [{
        componentIndex,
        invoiceLineId: Number.isInteger(Number(component.invoice_line_id))
          ? Number(component.invoice_line_id)
          : undefined,
        type,
        object,
        base: money(numberValue(component.base_amount)),
        amount,
        liabilityAccountId: Number.isInteger(liabilityAccountId) && liabilityAccountId > 0
          ? liabilityAccountId
          : null,
      }];
    });
  }
  const recalculated = recalculateVendorInvoiceBreakdown(invoiceBreakdown, vendorName);
  if (!recalculated) return [];

  return recalculated.components.flatMap((component, componentIndex) => {
    const amount = money(numberValue(component.withholding_tax_amount));
    const type = String(component.withholding_tax_type ?? "").trim();
    if (amount <= 0 || !type) return [];
    const object = String(
      component.tax_object
        ?? component.component
        ?? component.label
        ?? `component_${componentIndex + 1}`,
    ).trim() || `component_${componentIndex + 1}`;
    const liabilityAccountId = Number(component.liability_account_id);
    return [{
      componentIndex,
      type,
      object,
      base: money(numberValue(component.dpp ?? component.base_amount)),
      amount,
      liabilityAccountId: Number.isInteger(liabilityAccountId) && liabilityAccountId > 0
        ? liabilityAccountId
        : null,
    }];
  });
}

export function hasCombinedVendorWithholdingRow(
  taxRows: Array<Record<string, unknown>>,
  plans: VendorWithholdingTaxPlan[],
): boolean {
  if (taxRows.some((row) => /\s+\+\s+/.test(String(row.tax_type ?? "")))) return true;
  if (plans.length <= 1) return false;
  return taxRows.some((row) => !plans.some((plan) =>
    plan.type === String(row.tax_type ?? "").trim()
    && plan.object === String(row.tax_object ?? "").trim()
    && Math.abs(plan.amount - numberValue(row.tax_amount)) <= 0.01
  ));
}

export function inferVendorInvoiceGrossSettlement(input: {
  paymentAmount: number;
  outstanding: number;
  withholdingAmount: number;
  requestedWithholdingAmount?: number;
}): { grossAmount: number; withholdingAmount: number } {
  const requested = money(input.requestedWithholdingAmount ?? 0);
  const persisted = money(input.withholdingAmount);
  const inferred = requested > 0
    ? requested
    : persisted > 0 && Math.abs(input.paymentAmount - (input.outstanding - persisted)) <= 0.01
      ? persisted
      : 0;
  return { grossAmount: money(input.paymentAmount + inferred), withholdingAmount: inferred };
}

export function resolveVendorInvoiceNetSettlement(input: {
  paymentAmount: number;
  outstanding: number;
  taxes: Array<{ amount: number; liabilityAccountId: number | null }>;
}): {
  grossAmount: number;
  withholdingAmount: number;
  liabilityCredits: Array<{ accountId: number; amount: number }>;
} {
  const withholdingAmount = money(input.taxes.reduce((sum, tax) => sum + numberValue(tax.amount), 0));
  const settlement = inferVendorInvoiceGrossSettlement({
    paymentAmount: input.paymentAmount,
    outstanding: input.outstanding,
    withholdingAmount,
  });
  if (settlement.withholdingAmount <= 0) {
    return { ...settlement, liabilityCredits: [] };
  }
  const liabilityCredits = input.taxes.map((tax) => {
    if (!Number.isInteger(tax.liabilityAccountId) || Number(tax.liabilityAccountId) <= 0) {
      throw Object.assign(
        new Error("COA Hutang PPh belum terpetakan"),
        { httpStatus: 422, code: "WITHHOLDING_LIABILITY_ACCOUNT_REQUIRED" },
      );
    }
    return { accountId: Number(tax.liabilityAccountId), amount: money(tax.amount) };
  });
  return { ...settlement, liabilityCredits };
}

export function deriveVendorInvoicePaymentStatus(input: {
  amountPaid: number;
  grandTotal: number;
  currentStatus: string;
  hasWithholding: boolean;
  withholdingComplete: boolean;
}): "draft" | "posted" | "paid" {
  const fullyPaid = input.grandTotal > 0 && input.amountPaid >= input.grandTotal - 0.01;
  if (fullyPaid && (!input.hasWithholding || input.withholdingComplete)) return "paid";
  return input.currentStatus === "draft" ? "draft" : "posted";
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function legacyWithholding(invoice: Record<string, unknown>): {
  amount: number;
  type: string;
  object: string;
  base: number;
} {
  const breakdown = jsonObject(invoice.invoice_breakdown);
  const withholding = jsonObject(breakdown.withholding_tax);
  const recalculated = recalculateVendorInvoiceBreakdown(
    invoice.invoice_breakdown,
    String(invoice.supplier_name ?? ""),
  );
  const amount = money(
    numberValue(invoice.withholding_tax_amount)
      || numberValue(recalculated?.withholding.amount)
      || numberValue(recalculated?.totals.withholding_tax_amount)
      || numberValue(withholding.amount),
  );
  const type = String(
    invoice.withholding_tax_type
      || recalculated?.withholding.type
      || withholding.type
      || "PPh",
  ).trim() || "PPh";
  const object = String(invoice.tax_object || "legacy_invoice_header").trim() || "legacy_invoice_header";
  const base = money(
    numberValue(recalculated?.withholding.base_amount)
      || numberValue(recalculated?.totals.dpp)
      || numberValue(withholding.base_amount)
      || numberValue(invoice.total_amount),
  );
  return { amount, type, object, base };
}

/**
 * Creates the persisted withholding linkage used by payment and proof review.
 *
 * Existing reviewed/proof rows are never downgraded. Legacy header-only PPh is
 * represented by one explicit line-tax row so a historical invoice can enter
 * the same lifecycle as a newly captured invoice.
 */
export async function ensureVendorWithholdingRecords(
  executor: SqlExecutor,
  companyId: number,
  vendorInvoiceId: number,
): Promise<{ withholdingAmount: number; recordCount: number }> {
  const invoiceRows = rows<Record<string, unknown>>(await executor.execute(sql`
    SELECT id, invoice_number, supplier_name, total_amount, withholding_tax_amount,
           withholding_tax_type, tax_object, withholding_review_status, invoice_breakdown
    FROM vendor_invoices
    WHERE id = ${vendorInvoiceId} AND company_id = ${companyId}
    LIMIT 1
  `));
  const invoice = invoiceRows[0];
  if (!invoice) return { withholdingAmount: 0, recordCount: 0 };
  if (isVendorWithholdingDisabled(invoice)) {
    // Do not inspect or materialize legacy line-tax/breakdown data for an
    // explicitly disabled invoice. Cleanup is performed by the scoped repair
    // transaction; this path must remain side-effect free.
    return { withholdingAmount: 0, recordCount: 0 };
  }

  const legacy = legacyWithholding(invoice);
  const componentPlans = vendorWithholdingTaxPlans(
    invoice.invoice_breakdown,
    String(invoice.supplier_name ?? ""),
  );
  let taxRows = rows<Record<string, unknown>>(await executor.execute(sql`
    SELECT vit.id AS line_tax_id, vit.invoice_line_id, vit.tax_type, vit.tax_object,
           vit.base_amount, vit.tax_amount, vit.liability_account_id
    FROM vendor_invoice_line_taxes vit
    INNER JOIN vendor_invoice_lines vil ON vil.id = vit.invoice_line_id
    WHERE vil.invoice_id = ${vendorInvoiceId}
      AND vit.company_id = ${companyId}
      AND vit.tax_amount > 0
    ORDER BY vit.id
  `));

  // Reconcile older imports against every component/type/object. This is
  // idempotent and also completes partially materialized mixed invoices.
  if (componentPlans.length > 0 || legacy.amount > 0) {
    let lineRows = rows<{ id: number }>(await executor.execute(sql`
      SELECT id
      FROM vendor_invoice_lines
      WHERE invoice_id = ${vendorInvoiceId}
      ORDER BY id
    `));
    if (lineRows.length === 0) {
      lineRows = rows<{ id: number }>(await executor.execute(sql`
        INSERT INTO vendor_invoice_lines
          (invoice_id, name, quantity, unit, unit_cost, subtotal, tax_amount,
           coa_resolution_status, notes)
        VALUES
          (${vendorInvoiceId}, ${`PPh withholding — ${String(invoice.invoice_number ?? vendorInvoiceId)}`},
           '1', 'tax', '0', '0', '0', 'confirmed', 'Synthetic legacy header withholding line')
        RETURNING id
      `));
    }
    const firstInvoiceLineId = Number(lineRows[0]?.id ?? 0);
    if (firstInvoiceLineId) {
      const rawPlans = (componentPlans.length > 0
        ? componentPlans
        : [{
            componentIndex: 0,
            type: legacy.type,
            object: legacy.object,
            base: legacy.base,
            amount: legacy.amount,
            liabilityAccountId: null,
          }]).map((plan) => ({
            ...plan,
            invoiceLineId: plan.invoiceLineId
              ?? Number(lineRows[plan.componentIndex]?.id ?? firstInvoiceLineId),
          }));
      const plans = Array.from(rawPlans.reduce((byKey, plan) => {
        const key = `${plan.invoiceLineId}\u0000${plan.type}\u0000${plan.object}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.base = money(existing.base + plan.base);
          existing.amount = money(existing.amount + plan.amount);
        } else {
          byKey.set(key, { ...plan });
        }
        return byKey;
      }, new Map<string, typeof rawPlans[number]>()).values());
      if (plans.some((plan) => /\s+\+\s+/.test(plan.type))) {
        throw Object.assign(
          new Error(
            `Invoice ${String(invoice.invoice_number ?? vendorInvoiceId)} hanya memiliki header PPh gabungan. `
            + "Rincian per jenis dan tax object wajib diperbaiki sebelum pembayaran.",
          ),
          { httpStatus: 422, code: "COMBINED_VENDOR_WITHHOLDING_ROW" },
        );
      }
      const expectedKey = (value: {
        invoiceLineId: number;
        type: string;
        object: string;
        amount: number;
      }) => `${value.invoiceLineId}\u0000${value.type}\u0000${value.object}\u0000${money(value.amount)}`;
      const expectedKeys = new Set(plans.map(expectedKey));
      const persistedKeys = taxRows.map((tax) => expectedKey({
        invoiceLineId: Number(tax.invoice_line_id),
        type: String(tax.tax_type ?? "").trim(),
        object: String(tax.tax_object ?? "").trim(),
        amount: numberValue(tax.tax_amount),
      }));
      if (
        hasCombinedVendorWithholdingRow(taxRows, componentPlans)
        || persistedKeys.some((key) => !expectedKeys.has(key))
        || new Set(persistedKeys).size !== persistedKeys.length
      ) {
        throw Object.assign(
          new Error(
            `Invoice ${String(invoice.invoice_number ?? vendorInvoiceId)} memiliki baris PPh gabungan atau tidak sesuai rincian. `
            + "Pisahkan setiap jenis dan tax object PPh serta petakan COA liabilitas sebelum pembayaran.",
          ),
          { httpStatus: 422, code: "COMBINED_VENDOR_WITHHOLDING_ROW" },
        );
      }
      for (const plan of plans) {
        const exists = taxRows.some((tax) =>
          Number(tax.invoice_line_id) === plan.invoiceLineId
          && String(tax.tax_type ?? "").trim() === plan.type
          && String(tax.tax_object ?? "").trim() === plan.object
        );
        if (exists) continue;
        await executor.execute(sql`
          INSERT INTO vendor_invoice_line_taxes
            (invoice_line_id, company_id, tax_type, tax_object, base_amount, tax_amount,
             liability_account_id, resolution_status, review_reason)
          VALUES
            (${plan.invoiceLineId}, ${companyId}, ${plan.type}, ${plan.object},
             ${String(plan.base)}, ${String(plan.amount)}, NULL,
             'tax_review',
             'Created from legacy vendor invoice withholding breakdown')
          ON CONFLICT (invoice_line_id, tax_type, tax_object)
          DO UPDATE SET
            base_amount = EXCLUDED.base_amount,
            tax_amount = EXCLUDED.tax_amount,
            updated_at = NOW()
        `);
      }
      taxRows = rows<Record<string, unknown>>(await executor.execute(sql`
        SELECT vit.id AS line_tax_id, vit.invoice_line_id, vit.tax_type, vit.tax_object,
               vit.base_amount, vit.tax_amount, vit.liability_account_id
        FROM vendor_invoice_line_taxes vit
        INNER JOIN vendor_invoice_lines vil ON vil.id = vit.invoice_line_id
        WHERE vil.invoice_id = ${vendorInvoiceId}
          AND vit.company_id = ${companyId}
          AND vit.tax_amount > 0
        ORDER BY vit.id
      `));
      const finalKeys = taxRows.map((tax) => expectedKey({
        invoiceLineId: Number(tax.invoice_line_id),
        type: String(tax.tax_type ?? "").trim(),
        object: String(tax.tax_object ?? "").trim(),
        amount: numberValue(tax.tax_amount),
      }));
      if (
        finalKeys.length !== plans.length
        || new Set(finalKeys).size !== finalKeys.length
        || finalKeys.some((key) => !expectedKeys.has(key))
      ) {
        throw Object.assign(
          new Error(
            `Invoice ${String(invoice.invoice_number ?? vendorInvoiceId)} belum memiliki rincian PPh yang konsisten.`,
          ),
          { httpStatus: 422, code: "VENDOR_WITHHOLDING_ROWS_INCOMPLETE" },
        );
      }
    }
  }

  for (const tax of taxRows) {
    const lineTaxId = Number(tax.line_tax_id);
    const invoiceLineId = Number(tax.invoice_line_id);
    if (!lineTaxId || !invoiceLineId) continue;
    await executor.execute(sql`
      INSERT INTO vendor_withholding_records
        (company_id, vendor_invoice_id, invoice_line_id, line_tax_id,
         tax_type, tax_object, base_amount, tax_amount, liability_account_id,
         status)
      VALUES
        (${companyId}, ${vendorInvoiceId}, ${invoiceLineId}, ${lineTaxId},
         ${String(tax.tax_type ?? "PPh")}, ${String(tax.tax_object ?? "")},
         ${String(numberValue(tax.base_amount))}, ${String(numberValue(tax.tax_amount))},
         ${tax.liability_account_id == null ? null : Number(tax.liability_account_id)},
         'proof_pending')
      ON CONFLICT (line_tax_id)
      DO UPDATE SET
        tax_type = EXCLUDED.tax_type,
        tax_object = EXCLUDED.tax_object,
        base_amount = EXCLUDED.base_amount,
        tax_amount = EXCLUDED.tax_amount,
        liability_account_id = COALESCE(EXCLUDED.liability_account_id, vendor_withholding_records.liability_account_id),
        updated_at = NOW()
    `);
  }

  const recordRows = rows<{ status: string; tax_amount: string }>(await executor.execute(sql`
    SELECT status, tax_amount
    FROM vendor_withholding_records
    WHERE company_id = ${companyId} AND vendor_invoice_id = ${vendorInvoiceId}
  `));
  return {
    withholdingAmount: money(recordRows.reduce((sum, record) => sum + numberValue(record.tax_amount), 0)),
    recordCount: recordRows.length,
  };
}

/**
 * Recalculates only the payment status. Three-way match status is deliberately
 * not touched here because it describes PO/GR/Invoice matching, not payment.
 */
export async function recalculateVendorInvoicePaymentStatus(
  executor: SqlExecutor,
  companyId: number,
  vendorInvoiceId: number,
): Promise<{ status: string; amountPaid: number; withholdingComplete: boolean }> {
  const linkage = await ensureVendorWithholdingRecords(executor, companyId, vendorInvoiceId);
  const invoiceRows = rows<Record<string, unknown>>(await executor.execute(sql`
    SELECT amount_paid, grand_total, status, withholding_tax_amount,
           withholding_review_status
    FROM vendor_invoices
    WHERE id = ${vendorInvoiceId} AND company_id = ${companyId}
    FOR UPDATE
  `));
  const invoice = invoiceRows[0];
  if (!invoice) {
    return { status: "missing", amountPaid: 0, withholdingComplete: false };
  }
  const withholdingDisabled = isVendorWithholdingDisabled(invoice);

  const records = rows<{ status: string; resolution_status: string }>(await executor.execute(sql`
    SELECT vwr.status, vit.resolution_status
    FROM vendor_withholding_records vwr
    INNER JOIN vendor_invoice_line_taxes vit ON vit.id = vwr.line_tax_id
    WHERE vwr.company_id = ${companyId} AND vwr.vendor_invoice_id = ${vendorInvoiceId}
  `));
  if (withholdingDisabled && records.length > 0) {
    throw Object.assign(
      new Error("Invoice PPh-disabled masih memiliki record withholding yang harus dibersihkan."),
      { httpStatus: 409, code: "WITHHOLDING_DISABLED_STATE_DIRTY" },
    );
  }
  const hasWithholding = !withholdingDisabled
    && (linkage.withholdingAmount > 0 || records.length > 0);
  const withholdingComplete = !hasWithholding
    || (records.length > 0 && records.every((record) =>
      TERMINAL_WITHHOLDING_STATUSES.has(String(record.status))
      && ["confirmed", "approved"].includes(String(record.resolution_status)),
    ));
  const amountPaid = money(numberValue(invoice.amount_paid));
  const grandTotal = money(numberValue(invoice.grand_total));
  let effectiveAmountPaid = amountPaid;

  // Legacy reconciliation records can contain only the cash transferred to
  // the supplier. Promote that amount to gross only when the exact gap is the
  // persisted withholding amount and an approved OUT mutation has accounting
  // evidence. This repairs the payment projection without creating another
  // journal or bank transaction.
  if (amountPaid > 0 && amountPaid < grandTotal - 0.01 && linkage.withholdingAmount > 0) {
    const evidenceRows = rows<{ mutation_id: number; candidate_source: string | null }>(
      await executor.execute(sql`
        SELECT brm.mutation_id, brm.candidate_source::text AS candidate_source
        FROM public.bank_reconciliation_matches brm
        INNER JOIN public.bank_mutations bm ON bm.id = brm.mutation_id
        INNER JOIN public.accounting_entries ae
          ON ae.id = bm.journal_entry_id
         AND ae.company_id = ${companyId}
         AND ae.status = 'posted'
        WHERE brm.candidate_type::text = 'vendor_invoice'
          AND brm.candidate_id::text = ${String(vendorInvoiceId)}
          AND brm.status::text = 'approved'
          AND bm.direction::text = 'OUT'
          AND bm.status::text IN ('posted', 'reconciled')
        ORDER BY brm.id DESC
        LIMIT 1
      `),
    );
    const inferredSettlement = inferVendorInvoiceGrossSettlement({
      paymentAmount: amountPaid,
      // amountPaid may be the net cash transferred to the supplier. Compare
      // that cash with the pre-payment invoice balance so persisted
      // withholding can close the remaining gross liability.
      outstanding: grandTotal,
      withholdingAmount: linkage.withholdingAmount,
    });
    if (evidenceRows.length > 0 && inferredSettlement.grossAmount >= grandTotal - 0.01) {
      effectiveAmountPaid = grandTotal;
      await executor.execute(sql`
        UPDATE vendor_invoices
        SET amount_paid = ${String(grandTotal)},
            updated_at = NOW()
        WHERE id = ${vendorInvoiceId}
          AND company_id = ${companyId}
          AND amount_paid = ${String(amountPaid)}
      `);
    }
  }

  const nextStatus = deriveVendorInvoicePaymentStatus({
    amountPaid: effectiveAmountPaid,
    grandTotal,
    currentStatus: String(invoice.status),
    hasWithholding,
    withholdingComplete,
  });
  const nextWithholdingReviewStatus = hasWithholding
    ? withholdingComplete ? "completed" : "required"
    : "not_required";

  await executor.execute(sql`
    UPDATE vendor_invoices
    SET status = ${nextStatus},
        withholding_review_status = ${nextWithholdingReviewStatus},
        withholding_review_completed_at = CASE
          WHEN ${nextWithholdingReviewStatus} = 'completed' THEN COALESCE(withholding_review_completed_at, NOW())
          ELSE NULL
        END,
        updated_at = NOW()
    WHERE id = ${vendorInvoiceId} AND company_id = ${companyId}
  `);
  return { status: nextStatus, amountPaid: effectiveAmountPaid, withholdingComplete };
}
