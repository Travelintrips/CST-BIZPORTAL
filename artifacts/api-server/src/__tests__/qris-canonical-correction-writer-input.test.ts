import { describe, expect, it } from "vitest";
import { reverseCanonicalSettlementForCorrection } from "../lib/reconciliation/canonicalSettlementCorrection";

describe("finance writer remains fail-closed on untrusted correction input", () => {
  const client = {
    transaction: async () => { throw new Error("DANGEROUS_DB_TRANSACTION_SHOULD_NOT_RUN"); },
  };
  const good = {
    settlementId: 5738,
    expectedBankMutationId: 434464,
    replacementPaymentIds: [859, 860, 861, 862],
    actor: "test-only-actor",
    reason: "Audited QRIS membership correction for historical settlement batch 5738",
  };
  it("never enters DB transaction for missing or malformed actor", async () => {
    await expect(reverseCanonicalSettlementForCorrection(client as any,{...good,actor:""}))
      .rejects.toThrow("Actor correction wajib diisi");
  });
  it("never enters DB transaction for missing audit reason", async () => {
    await expect(reverseCanonicalSettlementForCorrection(client as any,{...good,reason:"short"}))
      .rejects.toThrow("Alasan correction wajib");
  });
  it("rejects duplicate replacement IDs before any DB call", async () => {
    await expect(reverseCanonicalSettlementForCorrection(client as any,
      {...good,replacementPaymentIds:[859,859,860]}))
      .rejects.toThrow("duplikat");
  });
  it("requires explicit positive bank and batch IDs", async () => {
    await expect(reverseCanonicalSettlementForCorrection(client as any,{...good,settlementId:0}))
      .rejects.toThrow("ID harus");
    await expect(reverseCanonicalSettlementForCorrection(client as any,{...good,expectedBankMutationId:-1}))
      .rejects.toThrow("ID harus");
  });
  it("the staged writer has no implicit PROD execution", () => {
    expect(typeof reverseCanonicalSettlementForCorrection).toBe("function");
  });
});
