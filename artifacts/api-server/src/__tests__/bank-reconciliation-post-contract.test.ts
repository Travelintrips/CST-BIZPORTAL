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
  });

  it("does not rematch tenant payment rows already marked as duplicates", () => {
    expect(api).toContain("duplicate_of_payment_id");
    expect(api).toContain("nullif(to_jsonb(tp)->>'duplicate_of_payment_id', '') is null");
    expect(api).toContain("ae.source_id in (");
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

  it("projects the actual posted journal COA lines into the mutation list", () => {
    expect(api).toContain("as journal_status");
    expect(api).toContain("as posted_coa_accounts");
    expect(api).toContain("entry.status = 'posted'");
    expect(api).toContain("entry.company_id = bm.company_id");
    expect(ui).toContain("Diposting ke akun COA");
    expect(ui).toContain('const side = debit > 0 ? "Debit" : credit > 0 ? "Kredit" : null;');
    expect(ui).toContain("· {side} {idr(amount)}");
  });
});
