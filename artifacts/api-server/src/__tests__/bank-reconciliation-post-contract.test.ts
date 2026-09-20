import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const api = readFileSync(
  fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)),
  "utf8",
);
const ui = readFileSync(
  fileURLToPath(new URL("../../../bizportal/src/pages/accounting/bank-reconciliation.tsx", import.meta.url)),
  "utf8",
);

describe("bank reconciliation post contract", () => {
  it("exposes a mutation-scoped journal detail endpoint", () => {
    expect(api).toContain('router.get("/bank-reconciliation/:mutationId/journal-entry"');
    expect(api).toContain("(source='bank_reconciliation' and source_id=$3)");
    expect(ui).toContain('/api/bank-reconciliation/${mutationId}/journal-entry');
  });

  it("routes manual posting through the canonical transactional service", () => {
    expect(api).toContain('router.post("/bank-reconciliation/:mutationId/post"');
    expect(api).toContain("postBankMutationCanonical(");
    expect(api).toContain("CANONICAL_SETTLEMENT_GENERIC_POST_BLOCKED");
    expect(ui).toContain('/api/bank-reconciliation/${mutId}/post');
  });

  it("allows governed direct-bank posting when the rule does not require a candidate", () => {
    expect(api).toContain("governedDirectAllocation");
    expect(api).toContain("meta->>'manual_coa_override'");
    expect(api).toContain("approvedMatch?.id ?? null");
    expect(api).toContain("matchId: number | null");
    expect(api).toContain("if (matchId != null)");
  });

  it("does not label manual canonical posting as Rule AI", () => {
    expect(api).toContain('String(meta.review_code ?? "CANONICAL_POSTED")');
    expect(api).toContain("review_code: 'RULE_AI_AUTO_POSTED'");
  });

  it("never defaults Sport Center or tenant source-owned receipts to AR", () => {
    expect(api).toContain('type === "sport_payment" || type === "tenant_invoice"');
    expect(api).toContain("fallback otomatis ke Piutang Usaha dinonaktifkan");
    expect(api).toContain("resolvePostedSourceReceiptJournal(");
    expect(api).toContain("SOURCE_JOURNAL_REQUIRED");
    expect(api).toContain("SOURCE_OWNED_COA_OVERRIDE_BLOCKED");
    expect(api).toContain("SOURCE_JOURNAL_REUSED");
    expect(api).toContain("SOURCE_JOURNAL_RECLASSIFIED");
  });

  it("does not rematch tenant payment rows already marked as duplicates", () => {
    expect(api).toContain("duplicate_of_payment_id");
    expect(api).toContain("nullif(to_jsonb(tp)->>'duplicate_of_payment_id', '') is null");
    expect(api).toContain("ae.source_id in (");
  });

  it("blocks one source-owned payment from being finalized by multiple bank mutations", () => {
    expect(api).toContain("assertSourceOwnedCandidateNotReconciledElsewhere(");
    expect(api).toContain("SOURCE_CANDIDATE_ALREADY_RECONCILED");
    expect(api).toContain("status in ('approved','posted')");
  });

  it("fails closed when a direct Sport Center transfer source journal uses the wrong bank COA", () => {
    expect(api).toContain("assertSportPaymentSourceReceiptAccount(");
    expect(api).toContain('method.includes("transfer")');
    expect(api).toContain('provider === "unknown" || provider === "manual"');
    expect(api).toContain("cba.account_number::text = $2");
    expect(api).toContain("SOURCE_PAYMENT_BANK_UNRESOLVED");
    expect(api).toContain("SOURCE_JOURNAL_BANK_MISMATCH");
  });

  it("reuses the source journal when the receipt account is already the actual bank", () => {
    expect(api).toContain("sourceReceiptJournal.debitAccountId === bankCoaId");
    expect(api).toContain("finalizeSourceJournalReuse(");
    expect(api).toContain("source_journal_reused: true");
    expect(ui).toContain("jurnal sumber direuse, tanpa jurnal duplikat");
  });

  it("reclassifies the source receipt account instead of crediting revenue or AR when bank differs", () => {
    expect(api).toContain("sourceReceiptJournal.debitAccountId");
    expect(api).toContain("Reklasifikasi penerimaan dari");
    expect(api).toContain("&& !realCandidate");
  });

  it("does not diagnose a voided or non-posted linked journal as resolved", () => {
    expect(api).toContain("journal?.status === 'posted'");
    expect(api).toContain("linkedJournalNotPosted");
    expect(api).toContain("LINKED_JOURNAL_NOT_POSTED");
    expect(api).toContain("journalStatus: journal?.status ?? null");
  });

  it("projects source-owned journal lines and shows the final accounting effect", () => {
    expect(api).toContain("as source_posted_coa_accounts");
    expect(api).toContain("bm.linked_transaction_type = 'sport_payment'");
    expect(api).toContain("candidate_entry.source_payment_id = bm.linked_transaction_id");
    expect(api).toContain("source_journal_id: sourceReceiptJournal?.entryId ?? null");
    expect(api).toContain("linked_transaction_type = $5");
    expect(ui).toContain("finalPostedCoaAccounts");
    expect(ui).toContain("Hasil akuntansi final");
    expect(ui).toContain("jurnal rekonsiliasi hanya memindahkan saldo ke rekening bank aktual");
  });

  it("includes Sport Center source PPN corrections in the final COA projection", () => {
    expect(api).toContain("as source_correction_coa_accounts");
    expect(api).toContain("correction_entry.source::text = 'sport_center_ppn_correction'");
    expect(api).toContain("select sp.booking_id");
    expect(ui).toContain("source_correction_coa_accounts");
    expect(ui).toContain("accountsToNet");
    expect(ui).toContain("Nilai ini sudah memasukkan jurnal koreksi sumber");
  });

  it("projects the actual posted journal COA lines into the mutation list", () => {
    expect(api).toContain("as journal_status");
    expect(api).toContain("as posted_coa_accounts");
    expect(api).toContain("entry.status = 'posted'");
    expect(api).toContain("entry.company_id = bm.company_id");
    expect(ui).toContain("Diposting ke akun COA");
    expect(ui).toContain('const side = debit > 0 ? "Debit" : credit > 0 ? "Kredit" : null;');
    expect(ui).toContain("· {side} {idr(accountAmount)}");
  });
});
