import { describe, expect, it } from "vitest";
import {
  getQrisResettablePayments,
  groupQrisResetHistoryByDate,
  groupQrisResettablePaymentsByDate,
  parseQrisResetHistory,
  resetQrisPaymentsSequentially,
} from "../lib/qrisSettlementReset";

describe("QRIS settlement reset selection", () => {
  it("excludes payments already owned by an active or posted batch", () => {
    const payments = getQrisResettablePayments([{
      estimated_settlement_date: "2026-09-16",
      active_settlement_payment_ids: [101],
      settled_payment_ids: [102],
      payment_items: [
        { paymentId: 101, paymentNumber: "ACTIVE", settlementStatus: "settled" },
        { paymentId: 102, paymentNumber: "POSTED", settlementStatus: "reconciled" },
        { paymentId: 103, paymentNumber: "RESETTABLE", settlementStatus: "settled" },
      ],
    }]);

    expect(payments).toEqual([{
      paymentId: 103,
      paymentNumber: "RESETTABLE",
      settlementDate: "2026-09-16",
    }]);
  });

  it("groups eligible payments by reconciliation date and deduplicates snapshots", () => {
    const payments = getQrisResettablePayments([
      {
        estimated_settlement_date: "2026-09-17",
        payment_items: [
          { paymentId: 2, paymentNumber: "P-2", settlementStatus: "settled" },
          { paymentId: 1, paymentNumber: "P-1", settlementStatus: "settled" },
        ],
      },
      {
        estimated_settlement_date: "2026-09-16",
        payment_items: [
          { paymentId: 1, paymentNumber: "P-1-duplicate", settlementStatus: "settled" },
          { paymentId: 3, paymentNumber: "P-3", settlementStatus: "settled" },
        ],
      },
    ]);

    expect(groupQrisResettablePaymentsByDate(payments)).toEqual([
      {
        settlementDate: "2026-09-16",
        payments: [{ paymentId: 3, paymentNumber: "P-3", settlementDate: "2026-09-16" }],
      },
      {
        settlementDate: "2026-09-17",
        payments: [
          { paymentId: 2, paymentNumber: "P-2", settlementDate: "2026-09-17" },
          { paymentId: 1, paymentNumber: "P-1", settlementDate: "2026-09-17" },
        ],
      },
    ]);
  });
});

describe("QRIS bulk reset execution", () => {
  it("runs sequentially and preserves successful results when a payment fails", async () => {
    const calls: number[] = [];
    const result = await resetQrisPaymentsSequentially(
      [
        { paymentId: 1, paymentNumber: "P-1", settlementDate: "2026-09-16" },
        { paymentId: 2, paymentNumber: "P-2", settlementDate: "2026-09-16" },
        { paymentId: 3, paymentNumber: "P-3", settlementDate: "2026-09-16" },
      ],
      async (paymentId) => {
        calls.push(paymentId);
        if (paymentId === 2) throw new Error("batch aktif");
      },
    );

    expect(calls).toEqual([1, 2, 3]);
    expect(result).toEqual({
      succeededPaymentIds: [1, 3],
      failedPaymentIds: [2],
    });
  });
});

describe("QRIS reset audit history", () => {
  it("parses and groups server audit rows by settlement date", () => {
    const entries = parseQrisResetHistory([
      {
        id: 11,
        created_at: "2026-09-17T03:00:00.000Z",
        action: "reset_payment",
        module: "accounting",
        user_email: "finance@example.com",
        new_data: {
          action: "Reset status settlement QRIS",
          settlementDate: "2026-09-16",
          paymentCount: 2,
        },
      },
      {
        id: 12,
        created_at: "2026-09-17T03:01:00.000Z",
        action: "update",
        module: "accounting",
        user_email: "finance@example.com",
        after_data: {
          reason: "Reset status settlement QRIS melalui aksi langsung.",
          settlement_date: "2026-09-16",
        },
      },
      {
        id: 13,
        created_at: "2026-09-17T03:02:00.000Z",
        action: "update",
        module: "accounting",
        new_data: { action: "update payment amount" },
      },
    ]);

    expect(groupQrisResetHistoryByDate(entries)).toEqual([
      {
        settlementDate: "2026-09-16",
        paymentCount: 3,
        entries: [entries[0], entries[1]],
      },
    ]);
  });
});