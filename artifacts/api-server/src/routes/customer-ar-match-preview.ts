import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { authenticateAdmin, type AdminRequest } from "./admin-auth";
import { isDevelopmentEnvironment } from "./dev-auth";
import { buildCustomerArMatchPreview, type CustomerArInvoiceEvidence, type IncomingBankMutationEvidence } from "../lib/reconciliation/customerArMatchPreview";

const router: IRouter = Router();
router.use(authenticateAdmin);

const INVOICES_SQL = [
  "select sd.id, sd.company_id, sd.invoice_number, sd.customer_name,",
  "sd.invoice_status::text as invoice_status, sd.status::text as document_status,",
  "sd.payment_status::text as payment_status,",
  "ar.outstanding_amount::text as outstanding_amount,",
  "coalesce(ar.journal_posted, false) as ar_journal_posted",
  "from public.sales_documents sd",
  "left join lateral (",
  "  select sum(ledger.outstanding_amount)::numeric as outstanding_amount,",
  "         bool_and(ledger.gl_entry_id is not null and entry.status::text = 'posted') as journal_posted",
  "  from public.ar_subledger ledger",
  "  left join public.accounting_entries entry",
  "    on entry.id = ledger.gl_entry_id and entry.company_id = sd.company_id",
  "  where ledger.company_id = sd.company_id and ledger.invoice_id = sd.id",
  ") ar on true",
  "where sd.company_id = $1 and sd.invoice_status::text = 'invoiced'",
  "and sd.status::text not in ('cancelled', 'canceled', 'void')",
  "order by sd.id desc limit 300",
].join("\n");

const MUTATIONS_SQL = [
  "select id, company_id, direction, status, amount,",
  "description, bank_reference, provider_order_id",
  "from public.bank_mutations",
  "where company_id = $1 and upper(direction) = 'IN' and lower(status) = 'unmatched'",
  "order by created_at desc, id desc limit 300",
].join("\n");

/** Read-only preview. Never approves a mutation or posts a payment/journal. */
router.get("/sales/customer-invoices/auto-match-preview", async (request, response): Promise<void> => {
  if (!isDevelopmentEnvironment()) {
    response.status(404).json({ error: "Not found" });
    return;
  }
  const actor = (request as AdminRequest).adminUser;
  const requestedId = request.query.company_id ?? actor?.companyId;
  const companyId = Number(requestedId);
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    response.status(400).json({ error: "Pilih perusahaan untuk pemeriksaan AR.", code: "COMPANY_REQUIRED" });
    return;
  }
  const isPrivileged = ["super_admin", "owner"].includes(actor?.role.toLowerCase() ?? "");
  if (actor?.companyId != null && actor.companyId !== companyId && !isPrivileged) {
    response.status(403).json({ error: "Perusahaan di luar hak akses.", code: "COMPANY_SCOPE_MISMATCH" });
    return;
  }
  if (actor?.companyId == null && !isPrivileged && !isDevelopmentEnvironment()) {
    response.status(403).json({ error: "Hak akses perusahaan tidak terverifikasi.", code: "COMPANY_SCOPE_MISSING" });
    return;
  }

  try {
    const [invoiceRows, mutationRows] = await Promise.all([
      pool.query<{
        id: number; company_id: number; invoice_number: string | null;
        customer_name: string | null; invoice_status: string;
        document_status: string; payment_status: string;
        outstanding_amount: string | null; ar_journal_posted: boolean | null;
      }>(INVOICES_SQL, [companyId]),
      pool.query<{
        id: number; company_id: number; direction: string; status: string;
        amount: string; description: string | null; bank_reference: string | null;
        provider_order_id: string | null;
      }>(MUTATIONS_SQL, [companyId]),
    ]);

    const invoices: CustomerArInvoiceEvidence[] = invoiceRows.rows.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      invoiceNumber: row.invoice_number,
      customerName: row.customer_name,
      invoiceStatus: row.invoice_status,
      documentStatus: row.document_status,
      paymentStatus: row.payment_status,
      outstandingAmount: row.outstanding_amount == null ? null : Number(row.outstanding_amount),
      arJournalPosted: row.ar_journal_posted === true,
    }));
    const mutations: IncomingBankMutationEvidence[] = mutationRows.rows.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      direction: row.direction,
      status: row.status,
      amount: Number(row.amount),
      description: row.description,
      bankReference: row.bank_reference,
      providerOrderId: row.provider_order_id,
    }));
    const matches = buildCustomerArMatchPreview(invoices, mutations);
    const summary = {
      invoicedDocuments: invoices.length,
      missingInvoiceNumbers: invoices.filter((invoice) => !invoice.invoiceNumber?.trim()).length,
      missingPostedArEvidence: invoices.filter((invoice) => !invoice.arJournalPosted || invoice.outstandingAmount == null).length,
      unmatchedIncomingMutations: mutations.length,
      suggestedExact: matches.filter((match) => match.status === "candidate_ready_for_review").length,
      requiresReview: matches.filter((match) => match.status !== "candidate_ready_for_review").length,
    };
    response.json({
      mode: "read_only_preview",
      autoApproveEnabled: false,
      autoPostEnabled: false,
      companyId, summary, matches,
      warning: "Kandidat ini belum menjadi pembayaran/rekonsiliasi. Approval dan jurnal hanya melalui lifecycle canonical.",
    });
  } catch (error) {
    request.log.error({ error, companyId }, "Customer AR matching preview failed");
    response.status(503).json({ error: "Pemeriksaan matching Customer AR belum tersedia.", code: "CUSTOMER_AR_PREVIEW_UNAVAILABLE" });
  }
});

export default router;
