import { describe, expect, it } from "vitest";
import { reverseCanonicalSettlementForCorrection } from "../lib/reconciliation/canonicalSettlementCorrection";

const input = {
  settlementId: 5738,
  expectedBankMutationId: 434464,
  replacementPaymentIds: [859, 860, 861, 862],
  actor: "dev-test-only",
  reason: "Verify posted-unlinked correction refuses invalid historical evidence",
};

function scriptedClient(responses: Array<Array<Record<string, unknown>>>) {
  let calls = 0;
  const client = {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        execute: async () => {
          const next = responses[calls++];
          if (!next) throw new Error("UNEXPECTED_DATABASE_OPERATION");
          return { rows: next };
        },
      }),
  };
  return { client, getCalls: () => calls };
}

const batch = {
  id: 5738, company_id: 1, status: "posted",
  bank_mutation_id: null, canonical_bank_mutation_id: null,
  settlement_journal_id: 7207,
};
const journal = {
  id: 7207, status: "posted", journal_type: "settlement",
  is_reversal: false, settlement_batch_id: 5738,
};
const activeItems = [856, 859, 860, 861].map(payment_id => ({ payment_id }));

describe("Issue 292 actual writer read-only preconditions", () => {
  it("rejects posted batch without an actual H+1-invalid member before any writes", async () => {
    const { client, getCalls } = scriptedClient([
      [batch], [], [journal], activeItems,
      [{ member_count: 4, wrong_date_count: 0 }],
    ]);
    await expect(reverseCanonicalSettlementForCorrection(client as any, input))
      .rejects.toThrow("Posted settlement must contain a real H+1-invalid member");
    expect(getCalls()).toBe(5);
  });

  it("rejects missing replacement payments before any reversal journal is inserted", async () => {
    const { client, getCalls } = scriptedClient([
      [batch], [], [journal], activeItems,
      [{ member_count: 4, wrong_date_count: 1 }],
      [{ id: 859 }],
    ]);
    await expect(reverseCanonicalSettlementForCorrection(client as any, input))
      .rejects.toThrow("Satu atau lebih replacement payment tidak ditemukan");
    expect(getCalls()).toBe(6);
  });
});
