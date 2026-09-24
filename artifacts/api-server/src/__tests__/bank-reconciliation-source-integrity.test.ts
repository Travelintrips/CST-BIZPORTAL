import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/routes/bank-reconciliation.ts"),
  "utf8",
);

describe("bank reconciliation candidate source integrity", () => {
  it("maps the completed UI filter to final mutation statuses without an array parameter cast", () => {
    expect(source).toContain('filters.push("bm.status in (\'posted\', \'approved\')")');
    expect(source).not.toContain("bm.status = any(${values.length}::text[])");
  });

  it("binds ordinary status filters to SQL parameters", () => {
    expect(source).toContain("filters.push(`bm.status = $${values.length}`)");
    expect(source).not.toContain("filters.push(`bm.status = ${values.length}`)");
  });

  it("persists canonical source identities for locally generated candidates", () => {
    expect(source).toContain('"sport_center.sport_payments"');
    expect(source).toContain('"public.vendor_invoices"');
    expect(source).toContain("status, candidate_source");
  });

  it("revalidates the selected source before journal creation", () => {
    const validation = source.indexOf("await assertApprovalCandidateExists(");
    const journalLookup = source.indexOf("from public.accounting_journals", validation);
    expect(validation).toBeGreaterThan(-1);
    expect(journalLookup).toBeGreaterThan(validation);
  });

  it("uses the same legacy company scope for Sport Center matching and approval", () => {
    expect(source).toContain("where coalesce(sp.company_id, 1) = $1");
    expect(source).toContain("and coalesce(company_id, 1) = $2");
  });

  it("uses canonical QRIS settlements only", () => {
    expect(source).toContain("sport_center.payment_settlement_batches");
    expect(source).toContain("sport_center.payment_settlement_items");
    expect(source).toContain("canonical_qris_settlement");
    expect(source).toContain("LEGACY_QRIS_GENERATOR_REMOVED");
    expect(source).toContain("LEGACY_QRIS_APPROVAL_REMOVED");
    expect(source).not.toContain("qris_mutation_batch_candidates");
    expect(source).not.toContain("update public.qris_mutation_batch_candidates");
  });

  it("rejects legacy source-less matches and accounting_payment candidates", () => {
    expect(source).toContain("Kandidat lama tanpa candidate_source canonical tidak dapat di-approve");
    expect(source).not.toContain('candidateType === "accounting_payment"');
    expect(source).not.toContain('selectedCandidateType === "accounting_payment"');
    expect(source).not.toContain('selectedCandidateSource = match.candidate_source ?? requestedSource');
  });

  it("supersedes competing non-final candidates before approving the selected match", () => {
    expect(source).toContain("set status = 'superseded'");
    expect(source).toContain("and id <> $2");
    expect(source).toContain("and status not in ('approved', 'posted')");
  });
  it("approves canonical QRIS settlement as link-only without generic journal creation", () => {
    expect(source).toContain("async function approveCanonicalSettlementLink");
    expect(source).toContain("CANONICAL_SETTLEMENT_LINK_APPROVED");
    expect(source).toContain("status='reconciled',bank_mutation_id=$2,reconciled_at=now(),reconciled_by=$3");
    expect(source).toContain("set status='approved',reconciliation_status='approved',journal_entry_id=null");
    const branch = source.indexOf('selectedCandidateType === "qris_settlement"');
    const bankResolution = source.indexOf("const bankCoaId = await resolveApprovalBankAccount", branch);
    expect(branch).toBeGreaterThan(-1);
    expect(bankResolution).toBeGreaterThan(branch);
    expect(source.slice(branch, bankResolution)).toContain("return approveCanonicalSettlementLink(");
  });

  it("matches posted canonical QRIS settlements by net bank amount with one-day settlement tolerance", () => {
    expect(source).toContain('candidateType: "qris_settlement"');
    expect(source).toContain("if (hasQrisBankEvidenceForAutoPost(mutation))");
    expect(source).toContain("psb.net_amount::numeric as amount");
    expect(source).toContain("abs(psb.settlement_date - $3::date)::integer as date_distance_days");
    expect(source).toContain("psb.settlement_date between ($3::date - 1) and ($3::date + 1)");
    expect(source).toContain("order by abs(psb.settlement_date - $3::date), psb.id");
    expect(source).toContain("score: exactDateMatch ? 100 : 95");
    expect(source).toContain("psb.status::text = 'posted'");
    expect(source).toContain("psb.bank_mutation_id is null");
    expect(source).toContain("psb.canonical_bank_mutation_id is null");
    expect(source).toContain("sport_center.payment_settlement_batches");
    expect(source).toContain("sport_center.accounting_journals sj");
    expect(source).toContain("Nominal net dan tanggal settlement QRIS canonical cocok.");
    expect(source).toContain("Nominal net QRIS canonical cocok; tanggal settlement dalam toleransi 1 hari.");
  });

  it("uses total grouped Sport Center payment amount and source-qualified exclusions", () => {
    expect(source).toContain("sum(sp.amount::numeric) as amount");
    expect(source).not.toContain("max(sp.amount::numeric) as amount");
    expect(source).toContain("brm.candidate_source = 'sport_center.sport_payments'");
    expect(source).toContain("brm.candidate_source = 'public.tenant_payments'");
    expect(source).toContain("brm.candidate_source = 'public.vendor_invoices'");
  });

  it("matches paid Sport Center corporate invoices by net cash amount and paid date", () => {
    expect(source).toContain('"sport_company_invoice"');
    expect(source).toContain('"sport_center.company_invoices"');
    expect(source).toContain("nullif(ci.net_amount::numeric, 0)");
    expect(source).toContain("(ci.paid_at at time zone 'Asia/Jakarta')::date = $3::date");
    expect(source).toContain("fcm.approval_status = 'OWNER_APPROVED'");
    expect(source).toContain("join sport_center.sport_payments sp3 on sp3.booking_id = cii3.booking_id");
    expect(source).toContain("SPORT_COMPANY_INVOICE_ACCOUNTING_REVIEW_REQUIRED");
  });

  it("matches vendor invoices by canonical allocation balance", () => {
    expect(source).toContain("from public.payment_allocations pa");
    expect(source).toContain("join public.payment_matching_groups pmg on pmg.id = pa.group_id");
    expect(source).toContain("coalesce(pa.is_active, true) = true");
    expect(source).toContain("lower(coalesce(pmg.status, '')) in ('final', 'posted', 'reconciled')");
    expect(source).toContain("lower(coalesce(paid_bm.status, '')) in ('final', 'posted', 'reconciled')");
    expect(source).toContain("greatest(vi.grand_total::numeric - coalesce(cip.canonical_paid, 0), 0)");
    expect(source).not.toContain("vendor_invoices.amount_paid");
  });

  it("allocates vendor invoice payments through the local backend and mapped bank COA", () => {
    expect(source).toContain('router.post("/bank-reconciliation/:mutationId/vendor-invoice-payment-batch"');
    expect(source).toContain("const bankCoaId = await resolveApprovalBankAccount(");
    expect(source).toContain("bank_coa_code: bankAccount.code");
    expect(source).toContain("insert into public.payment_matching_groups");
    expect(source).toContain("insert into public.payment_allocations");
    expect(source).toContain("linked_transaction_type = 'vendor_invoice_batch'");
    expect(source).toContain("status = 'approved_pending_posting'");
  });

  it("releases vendor invoice allocations when an approved draft is unmatched", () => {
    expect(source).toContain("update public.payment_allocations");
    expect(source).toContain("set is_active = false");
    expect(source).toContain("update public.payment_matching_groups");
    expect(source).toContain("set status = 'reversed', updated_at = now()");
  });

  it("repairs one source-qualified candidate or accepts a governed direct-bank allocation", () => {
    expect(source).toContain("APPROVED_MATCH_REPAIRED");
    expect(source).toContain("candidate_source is not null");
    expect(source).toContain("status in ('candidate','matched','selected')");
    expect(source).toContain('entry?.source !== "bank_reconciliation"');
    expect(source).toContain("recoverableMatch.rows.length > 1");
    expect(source).toContain("governedDirectAllocation");
    expect(source).toContain("meta->>'manual_coa_override'");
    expect(source).toContain("nullif(meta->>'journal_entry_id','')::bigint=$2");
  });

  it("allows approved draft cancellation only while the linked journal is still draft", () => {
    expect(source).toContain('"approved_pending_posting",\n      "approved",');
    expect(source).toContain('String(mutation.journal_status ?? "").toLowerCase() !== "draft"');
    expect(source).toContain("Approval hanya dapat dibatalkan bila jurnal terkait masih berstatus draft.");
    expect(source).toContain("where id = $1 and status = 'draft'");
    expect(source).toContain("set status = 'superseded'");
  });

  it("prefers the posted payment_confirmed journal over one stale draft duplicate", () => {
    expect(source).toContain('const existingPosted = existing.status === "posted"');
    expect(source).toContain('const incomingPosted = journal.status === "posted"');
    expect(source).toContain("if (existingPosted !== incomingPosted)");
    expect(source).toContain("if (incomingPosted) journalByPayment.set(journal.payment_id, journal)");
    expect(source).toContain("lebih dari satu jurnal payment_confirmed dengan status finansial yang sama");
  });

  it("does not project stale legacy candidates back to the reconciliation UI", () => {
    expect(source).toContain("match.candidate_source is not null");
    expect(source).toContain("match.candidate_type = 'sport_payment' and match.candidate_source = 'sport_center.sport_payments'");
    expect(source).toContain("match.candidate_type = 'tenant_invoice' and match.candidate_source = 'public.tenant_payments'");
    expect(source).toContain("match.candidate_type = 'vendor_invoice' and match.candidate_source = 'public.vendor_invoices'");
    expect(source).toContain("match.candidate_type = 'qris_settlement' and match.candidate_source = 'sport_center.payment_settlement_batches'");
  });

  it("revalidates canonical QRIS bank evidence before link-only approval", () => {
    expect(source).toContain('String(mutation.direction ?? "").toUpperCase() !== "IN"');
    expect(source).toContain("Math.abs(mutationAmount - settlementAmount) <= 0.01");
    expect(source).toContain("calendarDateValue(mutation.transaction_date) === calendarDateValue(batch.settlement_date)");
    expect(source).toContain("CANONICAL_SETTLEMENT_EVIDENCE_INVALID");
    expect(source).toContain("from public.company_bank_accounts");
    expect(source).toContain("CANONICAL_SETTLEMENT_BANK_MISMATCH");
    expect(source).toContain("CANONICAL_GENERIC_JOURNAL_ALREADY_EXISTS");
  });

  it("requires active confirmed QRIS payments and a posted settlement journal", () => {
    expect(source).toContain("from sport_center.payment_settlement_items item");
    expect(source).toContain("join sport_center.sport_payments payment on payment.id=item.payment_id");
    expect(source).toContain("payment.status::text");
    expect(source).toContain("payment.payment_method::text");
    expect(source).toContain("CANONICAL_SETTLEMENT_PAYMENT_INVALID");
    expect(source).toContain("journal.company_id !== mutation.company_id");
    expect(source).toContain('journal.journal_type !== "settlement"');
    expect(source).toContain("journal.is_reversal");
  });

  it("keeps canonical QRIS link-only and does not restore legacy candidate storage", () => {
    const canonicalStart = source.indexOf("async function approveCanonicalSettlementLink");
    const approvalStart = source.indexOf("async function approveBankMutation", canonicalStart);
    const canonicalBody = source.slice(canonicalStart, approvalStart);
    expect(canonicalBody).toContain("journal_entry_id=null");
    expect(canonicalBody).not.toContain("insert into public.accounting_entries");
    expect(canonicalBody).not.toContain("qris_mutation_batch_candidates");
    expect(source).not.toContain("qris_mutation_batch_candidates");
  });
});
