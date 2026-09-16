import { describe, expect, it } from "vitest";
import {
  canonicalAmountPaid,
  formatPaymentMutationError,
  hasPaymentResetBlockers,
  outstandingNetPayment,
  vendorInvoicePaymentSummary,
} from "@/lib/vendorInvoicePayment";

describe("vendor invoice payment source of truth", () => {
  it("shows zero paid and the full net balance for a posted invoice without payment", () => {
    expect(vendorInvoicePaymentSummary({
      grandTotal: "100000",
      amount_paid: 0,
    })).toEqual({
      amountPaid: 0,
      estimatedNet: 100000,
      outstanding: 100000,
    });
  });

  it("uses only canonical amount_paid for a partial payment", () => {
    expect(vendorInvoicePaymentSummary({
      grand_total: 100000,
      amount_paid: 25000,
      status: "posted",
    })).toEqual({
      amountPaid: 25000,
      estimatedNet: 100000,
      outstanding: 75000,
    });
  });

  it("does not infer payment from posted status or grand total", () => {
    expect(canonicalAmountPaid({
      grandTotal: 100000,
      invoiceBreakdown: { totals: { payable_amount: 90000 } },
    })).toBe(0);
  });

  it("uses the canonical payment amount for a full payment", () => {
    expect(outstandingNetPayment({
      grandTotal: 100000,
      amount_paid: 100000,
    })).toBe(0);
  });

  it("calculates net transfer from PPh and never treats payable_amount as paid", () => {
    expect(vendorInvoicePaymentSummary({
      grandTotal: 100000,
      amount_paid: 0,
      invoiceBreakdown: {
        totals: {
          withholding_tax_amount: 2000,
          payable_amount: 98000,
        },
      },
    })).toEqual({
      amountPaid: 0,
      estimatedNet: 98000,
      outstanding: 98000,
    });
  });

  it("supports camelCase PPh values without treating them as payment", () => {
    expect(vendorInvoicePaymentSummary({
      grandTotal: 100000,
      amountPaid: 25000,
      invoiceBreakdown: {
        totals: {
          withholdingTaxAmount: 2000,
          payable_amount: 98000,
        },
      },
    })).toEqual({
      amountPaid: 25000,
      estimatedNet: 98000,
      outstanding: 73000,
    });
  });

  it("surfaces active payment records when reset is blocked", () => {
    const response = {
      blocked: true,
      message: "Reset pembayaran ditolak.",
      activePaymentLinks: [
        { id: 781, paymentNumber: "BD-00781", status: "posted" },
      ],
    };

    expect(hasPaymentResetBlockers(response)).toBe(true);
    expect(formatPaymentMutationError(response, "Fallback")).toBe(
      "Reset pembayaran ditolak. BD-00781 (posted)",
    );
  });
});