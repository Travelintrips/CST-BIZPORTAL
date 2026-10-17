import { describe, expect, it } from "vitest";
import { isInvalidPaymentCandidateIdentity } from "../lib/reconciliation/paymentCandidateIdentity.js";

describe("payment reconciliation candidate identity", () => {
  it.each([0, -1, 1.5, NaN, Infinity, "0", "42", null, undefined])(
    "rejects invalid payment id %s", (id) => {
      expect(isInvalidPaymentCandidateIdentity({ type: "payment", id })).toBe(true);
    },
  );

  it.each([1, 42, Number.MAX_SAFE_INTEGER])("allows positive integer payment id %s", (id) => {
    expect(isInvalidPaymentCandidateIdentity({ type: "payment", id })).toBe(false);
  });

  it.each([0, -1, NaN, "0"])("rejects invalid sport_payment id %s", (id) => {
    expect(isInvalidPaymentCandidateIdentity({ type: "sport_payment", id })).toBe(true);
  });

  it("allows a valid sport_payment identity", () => {
    expect(isInvalidPaymentCandidateIdentity({ type: "sport_payment", id: 42 })).toBe(false);
  });

  it("does not treat unrelated candidate types as payment identities", () => {
    expect(isInvalidPaymentCandidateIdentity({ type: "qris_settlement", id: 0 })).toBe(false);
  });
});
