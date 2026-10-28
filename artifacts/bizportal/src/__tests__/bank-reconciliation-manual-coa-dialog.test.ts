// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isGenericCoaSelectionEligible } from "../pages/accounting/bank-reconciliation";

type Mutation = Parameters<typeof isGenericCoaSelectionEligible>[0];
type Match = NonNullable<Mutation["candidates"]>[number];
const source = readFileSync(
  resolve(process.cwd(), "src/pages/accounting/bank-reconciliation.tsx"),
  "utf8",
);

function mutation(overrides: Partial<Mutation> = {}): Mutation {
  return {
    id: 101,
    company_id: 1,
    transaction_date: "2026-10-28",
    description: "Biaya rekening",
    credit_amount: "0",
    debit_amount: "50000",
    amount: "50000",
    direction: "OUT",
    mutation_key: "manual-coa-test",
    normalized_description: "biaya rekening",
    provider_name: "Mandiri",
    provider_order_id: null,
    status: "manual_review",
    matched_payment_id: null,
    matched_order_id: null,
    has_approved_match: false,
    candidates: [],
    qris_candidate_audit: null,
    qris_candidate_audits: [],
    ...overrides,
  } as Mutation;
}

function candidate(candidate_type: string, candidate_source: string): Match {
  return {
    id: 401,
    mutation_id: 101,
    candidate_type,
    candidate_id: 44,
    candidate_source,
    match_score: 85,
    match_reason: "Belum disetujui",
    amount_match: true,
    date_match: true,
    name_match: true,
    order_id_match: false,
    proof_match: false,
    status: "candidate",
  };
}

describe("Manual COA dialog responsiveness and approval guards", () => {
  it("allows a manual-review transaction to override only Rule AI hints", () => {
    expect(isGenericCoaSelectionEligible(mutation({
      candidates: [candidate("recon_rule", "public.recon_rules")],
    }))).toBe(true);
    expect(isGenericCoaSelectionEligible(mutation({ candidates: [] }))).toBe(true);
  });

  it("blocks a real source candidate until it is reviewed or rejected", () => {
    expect(isGenericCoaSelectionEligible(mutation({
      candidates: [candidate("sport_payment", "sport_center.sport_payments")],
    }))).toBe(false);
    expect(isGenericCoaSelectionEligible(mutation({
      candidates: [candidate("vendor_invoice", "public.vendor_invoices")],
    }))).toBe(false);
  });

  it("never allows generic COA for approved/posted or approved-match records", () => {
    expect(isGenericCoaSelectionEligible(mutation({ status: "posted" }))).toBe(false);
    expect(isGenericCoaSelectionEligible(mutation({ status: "approved_pending_posting" }))).toBe(false);
    expect(isGenericCoaSelectionEligible(mutation({ has_approved_match: true }))).toBe(false);
  });

  it("blocks inward QRIS canonical settlement", () => {
    expect(isGenericCoaSelectionEligible(mutation({
      direction: "IN",
      provider_name: "QRIS",
      description: "QRIS settlement batch",
    }))).toBe(false);
  });

  it("keeps action buttons visible without horizontal scrolling", () => {
    expect(source).toContain('className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg min-w-0 flex-col gap-0 overflow-hidden p-0"');
    expect(source).toContain('className="min-h-0 min-w-0 flex-1 space-y-3 overflow-x-hidden overflow-y-auto px-5 py-3"');
    expect(source).toContain('className="min-w-0 shrink-0 flex-wrap gap-2 border-t bg-background px-5 py-4 sm:flex-row sm:justify-end"');
  });

  it("requires explicit consent before superseding unapproved Rule AI hints", () => {
    expect(source).toContain("requiresOverrideAcknowledgement && !overrideAcknowledged");
    expect(source).toContain("checked={overrideAcknowledged}");
    expect(source).toContain("kandidat tersebut akan ditandai superseded");
    expect(source).toContain("{manualSelectionBlockedReason}");
    expect(source).toContain('manualSelectionBlockedReason ?? "Periksa status mutasi dan kandidat sumber."');
  });
});
