export type VendorInvoicePaymentFields = {
  grandTotal?: unknown;
  grand_total?: unknown;
  amountPaid?: unknown;
  amount_paid?: unknown;
  status?: unknown;
  withholdingTaxAmount?: unknown;
  withholding_tax_amount?: unknown;
  invoiceBreakdown?: {
    components?: Array<{
      withholding_tax_amount?: unknown;
    }>;
    totals?: {
      withholding_tax_amount?: unknown;
      payable_amount?: unknown;
    } | null;
  } | null;
};

function nonNegativeAmount(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

/**
 * Payment source of truth:
 * - amount_paid is the database/API canonical field
 * - amountPaid is accepted only as the API's camelCase serialization of that
 *   same field
 *
 * Never derive payment from grand total, payable amount, invoice status, or
 * invoice breakdown snapshots.
 */
export function canonicalAmountPaid(invoice: VendorInvoicePaymentFields): number {
  return nonNegativeAmount(invoice.amount_paid ?? invoice.amountPaid);
}

export function canonicalGrandTotal(invoice: VendorInvoicePaymentFields): number {
  return nonNegativeAmount(invoice.grand_total ?? invoice.grandTotal);
}

export function canonicalWithholdingAmount(invoice: VendorInvoicePaymentFields): number {
  const directAmount = invoice.withholding_tax_amount ?? invoice.withholdingTaxAmount;
  const breakdownTotal = invoice.invoiceBreakdown?.totals?.withholding_tax_amount;
  // These are tax amounts withheld, not payments. payable_amount is
  // intentionally ignored. Use the largest available representation because
  // APIs may expose the same withholding value at different nesting levels.
  const componentTotal = (invoice.invoiceBreakdown?.components ?? []).reduce(
    (sum, component) => sum + nonNegativeAmount(component.withholding_tax_amount),
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