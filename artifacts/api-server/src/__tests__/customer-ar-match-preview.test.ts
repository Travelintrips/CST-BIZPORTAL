import { describe, expect, it } from "vitest";
import {
  buildCustomerArMatchPreview,
  type CustomerArInvoiceEvidence,
  type IncomingBankMutationEvidence,
} from "../lib/reconciliation/customerArMatchPreview";

const invoice: CustomerArInvoiceEvidence = {
  id: 21,
  companyId: 1,
  invoiceNumber: "INV-2026-0088",
  customerName: "Pelanggan A",
  invoiceStatus: "invoiced",
  documentStatus: "confirmed",
  paymentStatus: "unpaid",
  outstandingAmount: 5_000_000,
  arJournalPosted: true,
};
const mutation: IncomingBankMutationEvidence = {
  id: 700,
  companyId: 1,
  direction: "IN",
  status: "unmatched",
  amount: 5_000_000,
  description: "Transfer pembayaran INV-2026-0088",
  bankReference: null,
  providerOrderId: null,
};

describe("customer AR bank matching (read-only preview)", () => {
  it("suggests full match only with invoice reference, company, and posted AR", () => {
    expect(buildCustomerArMatchPreview([invoice], [mutation])[0]).toMatchObject({
      status: "candidate_ready_for_review", invoiceId: 21,
    });
  });

  it("requires review for partial payment and overpayment", () => {
    expect(buildCustomerArMatchPreview([invoice], [{ ...mutation, amount: 2_000_000 }])[0]?.status)
      .toBe("partial_payment_review");
    expect(buildCustomerArMatchPreview([invoice], [{ ...mutation, amount: 6_000_000 }])[0]?.status)
      .toBe("overpayment_review");
  });

  it("never suggests settlement when AR ledger or posted journal is absent", () => {
    expect(buildCustomerArMatchPreview([{ ...invoice, arJournalPosted: false }], [mutation])[0]?.status)
      .toBe("unverified_ar_source");
    expect(buildCustomerArMatchPreview([{ ...invoice, outstandingAmount: null }], [mutation])[0]?.status)
      .toBe("unverified_ar_source");
  });

  it("does not substitute Sales Order numbers for missing customer invoice numbers", () => {
    expect(buildCustomerArMatchPreview([{ ...invoice, invoiceNumber: null }], [mutation])[0]?.status)
      .toBe("no_invoice_reference");
  });

  it("does not accept a partial-number collision", () => {
    expect(buildCustomerArMatchPreview([invoice], [{
      ...mutation, description: "TRF INV-2026-00880",
    }])[0]?.status).toBe("no_invoice_reference");
  });

  it("requires review for two different invoices mentioned in one transfer", () => {
    const second = { ...invoice, id: 22, invoiceNumber: "INV-2026-0099" };
    expect(buildCustomerArMatchPreview([invoice, second], [{
      ...mutation, description: "INV-2026-0088 INV-2026-0099",
    }])[0]?.status).toBe("ambiguous_invoice_reference");
  });

  it("requires review for repeated receipts referring to the same invoice", () => {
    const receipts = [mutation, { ...mutation, id: 701, amount: 1_000_000 }];
    expect(buildCustomerArMatchPreview([invoice], receipts).map((row) => row.status))
      .toEqual(["multiple_receipts_review", "multiple_receipts_review"]);
  });

  it("rejects cross-company, OUT, posted and paid rows from suggestions", () => {
    expect(buildCustomerArMatchPreview([invoice], [{ ...mutation, companyId: 2 }])[0]?.status)
      .toBe("no_invoice_reference");
    expect(buildCustomerArMatchPreview([invoice], [{ ...mutation, direction: "OUT" }]))
      .toEqual([]);
    expect(buildCustomerArMatchPreview([invoice], [{ ...mutation, status: "posted" }]))
      .toEqual([]);
    expect(buildCustomerArMatchPreview([{ ...invoice, paymentStatus: "paid" }], [mutation])[0]?.status)
      .toBe("no_invoice_reference");
  });

  it("can find the invoice in a bank reference even if the description is blank", () => {
    expect(buildCustomerArMatchPreview([invoice], [{
      ...mutation, description: null, bankReference: "INV-2026-0088",
    }])[0]?.status).toBe("candidate_ready_for_review");
  });
});
