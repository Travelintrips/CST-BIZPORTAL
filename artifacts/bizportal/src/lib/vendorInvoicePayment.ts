export type VendorInvoicePaymentFields = {
  grandTotal?: unknown;
  grand_total?: unknown;
  /**
   * Backend projection of active final/posted Bank Reconciliation
   * allocations. This is the preferred payment field for AP.
   */
  reconciledAmountPaid?: unknown;
  amountPaid?: unknown;
  amount_paid?: unknown;
  status?: unknown;
  withholdingTaxAmount?: unknown;
  withholding_tax_amount?: unknown;
  invoiceBreakdown?: {
    components?: Array<{
      withholding_tax_amount?: unknown;
      withholdingTaxAmount?: unknown;
    }>;
    totals?: {
      withholding_tax_amount?: unknown;
      withholdingTaxAmount?: unknown;
      payable_amount?: unknown;
    } | null;
  } | null;
};

function responseDetail(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const item = value as Record<string, unknown>;
  const label = [
    item.paymentNumber,
    item.disbursementNumber,
    item.reference,
    item.invoiceNumber,
    item.id != null ? `ID ${item.id}` : null,
  ].find((part) => part != null && String(part).trim() !== "");
  const status = item.status != null ? ` (${String(item.status)})` : "";
  return `${label != null ? String(label) : "Record pembayaran"}${status}`;
}

/**
 * Upstream reset endpoints may return HTTP 2xx while declining to change an
 * invoice because an active payment link still owns the payment. Treat that
 * response as blocked and retain the record-level explanation for the user.
 */
export function hasPaymentResetBlockers(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const payload = body as Record<string, unknown>;
  return payload.blocked === true
    || payload.success === false
    || payload.ok === false
    || payload.reset === false
    || [
    payload.blockers,
    payload.activePaymentLinks,
    payload.paymentLinks,
    payload.activePayments,
    ].some((value) => Array.isArray(value) && value.length > 0);
}

export function formatPaymentMutationError(body: unknown, fallback: string): string {
  const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const base = String(payload.message ?? payload.error ?? fallback);
  const reasonDetails = Array.isArray(payload.reasons)
    ? payload.reasons.map((reason) => {
      if (!reason || typeof reason !== "object") return String(reason ?? "");
      const item = reason as Record<string, unknown>;
      return String(item.message ?? item.code ?? responseDetail(item));
    }).filter(Boolean)
    : [];
  const blockerDetails = [
    payload.blockers,
    payload.activePaymentLinks,
    payload.paymentLinks,
    payload.activePayments,
  ].flatMap((blockers) => Array.isArray(blockers) ? blockers.map(responseDetail) : []);
  const details = [...reasonDetails, ...blockerDetails];
  return details.length > 0 ? `${base} ${details.join("; ")}` : base;
}

function nonNegativeAmount(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

/**
 * Payment source of truth:
 * - reconciledAmountPaid is the backend SUM of canonical Bank Reconciliation
 *   allocations with a final/posted settlement
 *
 * Never derive payment from grand total, payable amount, invoice status, or
 * invoice breakdown snapshots.
 */
export function canonicalAmountPaid(invoice: VendorInvoicePaymentFields): number {
  return nonNegativeAmount(invoice.reconciledAmountPaid);
}

export function canonicalGrandTotal(invoice: VendorInvoicePaymentFields): number {
  return nonNegativeAmount(invoice.grand_total ?? invoice.grandTotal);
}

export function canonicalWithholdingAmount(invoice: VendorInvoicePaymentFields): number {
  const directAmount = invoice.withholding_tax_amount ?? invoice.withholdingTaxAmount;
  const breakdownTotal = invoice.invoiceBreakdown?.totals?.withholding_tax_amount
    ?? invoice.invoiceBreakdown?.totals?.withholdingTaxAmount;
  // These are tax amounts withheld, not payments. payable_amount is
  // intentionally ignored. Use the largest available representation because
  // APIs may expose the same withholding value at different nesting levels.
  const componentTotal = (invoice.invoiceBreakdown?.components ?? []).reduce(
    (sum, component) => sum + nonNegativeAmount(
      component.withholding_tax_amount ?? component.withholdingTaxAmount,
    ),
    0,
  );
  return Math.max(
    nonNegativeAmount(directAmount),
    nonNegativeAmount(breakdownTotal),
    componentTotal,
  );
}

export function estimatedNetPayment(
  invoice: VendorInvoicePaymentFields,
  additionalWithholdingAmount = 0,
): number {
  const withholdingAmount = Math.max(
    canonicalWithholdingAmount(invoice),
    nonNegativeAmount(additionalWithholdingAmount),
  );
  return Math.max(0, canonicalGrandTotal(invoice) - withholdingAmount);
}

export function outstandingNetPayment(
  invoice: VendorInvoicePaymentFields,
  additionalWithholdingAmount = 0,
): number {
  return Math.max(
    0,
    estimatedNetPayment(invoice, additionalWithholdingAmount) - canonicalAmountPaid(invoice),
  );
}

export function vendorInvoicePaymentSummary(
  invoice: VendorInvoicePaymentFields,
  additionalWithholdingAmount = 0,
) {
  const amountPaid = canonicalAmountPaid(invoice);
  const estimatedNet = estimatedNetPayment(invoice, additionalWithholdingAmount);
  return {
    amountPaid,
    estimatedNet,
    outstanding: Math.max(0, estimatedNet - amountPaid),
  };
}