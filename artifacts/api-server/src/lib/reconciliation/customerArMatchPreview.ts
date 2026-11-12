/**
 * Read-only Customer AR matching preview.
 *
 * A suggestion is NOT a payment, approval, allocation, bank reconciliation or
 * accounting journal. Only an independently verified canonical settlement
 * owner may move an IN mutation to a final state.
 */
export interface CustomerArInvoiceEvidence {
  id: number;
  companyId: number;
  invoiceNumber: string | null;
  customerName: string | null;
  invoiceStatus: string;
  documentStatus: string;
  paymentStatus: string;
  outstandingAmount: number | null;
  arJournalPosted: boolean;
}

export interface IncomingBankMutationEvidence {
  id: number;
  companyId: number;
  direction: string;
  status: string;
  amount: number;
  description: string | null;
  bankReference: string | null;
  providerOrderId: string | null;
}

export type CustomerArMatchStatus =
  | "candidate_ready_for_review"
  | "partial_payment_review"
  | "overpayment_review"
  | "multiple_receipts_review"
  | "ambiguous_invoice_reference"
  | "unverified_ar_source"
  | "no_invoice_reference";

export interface CustomerArMatchPreview {
  mutationId: number;
  mutationAmount: number;
  status: CustomerArMatchStatus;
  invoiceId: number | null;
  invoiceNumber: string | null;
  reason: string;
}

function isPositiveAmount(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase().replace(/\s+/g, " ") : "";
}

function containsInvoiceReference(haystack: string, invoiceNumber: string): boolean {
  const candidate = normalize(invoiceNumber);
  if (candidate.length < 5) return false;
  const literal = Array.from(candidate)
    .map((character) => /[A-Z0-9]/.test(character) ? character : "\\" + character)
    .join("");
  return new RegExp("(^|[^A-Z0-9_/-])" + literal + "($|[^A-Z0-9_/-])").test(haystack);
}

function invoiceIsEligible(invoice: CustomerArInvoiceEvidence): boolean {
  return invoice.invoiceStatus.toLowerCase() === "invoiced"
    && !["cancelled", "canceled", "void", "draft"].includes(invoice.documentStatus.toLowerCase())
    && !["paid", "settled", "cancelled", "void"].includes(invoice.paymentStatus.toLowerCase());
}

function mutationIsEligible(mutation: IncomingBankMutationEvidence): boolean {
  return mutation.direction.toUpperCase() === "IN"
    && mutation.status.toLowerCase() === "unmatched"
    && isPositiveAmount(mutation.amount)
    && Number.isSafeInteger(mutation.id)
    && Number.isSafeInteger(mutation.companyId);
}

export function buildCustomerArMatchPreview(
  invoices: readonly CustomerArInvoiceEvidence[],
  mutations: readonly IncomingBankMutationEvidence[],
): CustomerArMatchPreview[] {
  const eligibleInvoices = invoices.filter(invoiceIsEligible);
  const eligibleMutations = mutations.filter(mutationIsEligible);
  const referencesByMutation = new Map<number, CustomerArInvoiceEvidence[]>();
  const receiptsByInvoice = new Map<number, Set<number>>();

  for (const mutation of eligibleMutations) {
    const haystack = normalize([
      mutation.description,
      mutation.bankReference,
      mutation.providerOrderId,
    ].filter(Boolean).join(" "));
    const referenced = eligibleInvoices.filter((invoice) =>
      invoice.companyId === mutation.companyId
      && containsInvoiceReference(haystack, invoice.invoiceNumber ?? ""),
    );
    referencesByMutation.set(mutation.id, referenced);
    for (const invoice of referenced) {
      const receiptIds = receiptsByInvoice.get(invoice.id) ?? new Set<number>();
      receiptIds.add(mutation.id);
      receiptsByInvoice.set(invoice.id, receiptIds);
    }
  }

  return eligibleMutations.map((mutation) => {
    const matched = referencesByMutation.get(mutation.id) ?? [];
    const base = {
      mutationId: mutation.id,
      mutationAmount: mutation.amount,
    };
    if (matched.length === 0) {
      return { ...base, status: "no_invoice_reference" as const,
        invoiceId: null, invoiceNumber: null,
        reason: "Tidak ada nomor invoice pelanggan yang terbukti dalam referensi mutasi." };
    }
    if (matched.length !== 1) {
      return { ...base, status: "ambiguous_invoice_reference" as const,
        invoiceId: null, invoiceNumber: null,
        reason: "Referensi menunjuk ke lebih dari satu invoice; wajib verifikasi." };
    }

    const invoice = matched[0]!;
    const info = { ...base, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber };
    if ((receiptsByInvoice.get(invoice.id)?.size ?? 0) > 1) {
      return { ...info, status: "multiple_receipts_review" as const,
        reason: "Beberapa mutasi menunjuk invoice yang sama; periksa pembayaran bertahap." };
    }
    if (!invoice.arJournalPosted || invoice.outstandingAmount == null
        || !isPositiveAmount(invoice.outstandingAmount)) {
      return { ...info, status: "unverified_ar_source" as const,
        reason: "Piutang AR dan jurnal invoice posted belum terbukti; tidak boleh auto-settle." };
    }
    const difference = Math.round((mutation.amount - invoice.outstandingAmount) * 100) / 100;
    if (Math.abs(difference) <= 0.01) {
      return { ...info, status: "candidate_ready_for_review" as const,
        reason: "Nomor invoice, perusahaan, arah dan outstanding AR cocok; hanya rekomendasi." };
    }
    if (difference < 0) {
      return { ...info, status: "partial_payment_review" as const,
        reason: "Pembayaran kurang dari sisa invoice; periksa alokasi parsial." };
    }
    return { ...info, status: "overpayment_review" as const,
      reason: "Pembayaran melebihi sisa invoice; periksa deposit atau multi-invoice." };
  });
}
