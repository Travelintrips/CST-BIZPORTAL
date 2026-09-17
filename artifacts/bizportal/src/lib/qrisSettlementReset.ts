export interface QrisResettablePayment {
  paymentId: number;
  paymentNumber: string;
  settlementDate: string;
}

interface QrisPaymentItemLike {
  paymentId?: number | string | null;
  payment_id?: number | string | null;
  paymentNumber?: string | null;
  payment_number?: string | null;
  expectedSettlementDate?: string | null;
  expected_settlement_date?: string | null;
  settlementStatus?: string | null;
  settlement_status?: string | null;
}

interface QrisCandidateLike {
  estimated_settlement_date?: string | null;
  active_settlement_payment_ids?: Array<number | string> | null;
  settled_payment_ids?: Array<number | string> | null;
  payment_items?: QrisPaymentItemLike[] | null;
}

export function getQrisResettablePayments(
  candidates: QrisCandidateLike[],
): QrisResettablePayment[] {
  const payments = new Map<number, QrisResettablePayment>();

  for (const candidate of candidates) {
    const blockedPaymentIds = new Set([
      ...(candidate.active_settlement_payment_ids ?? []),
      ...(candidate.settled_payment_ids ?? []),
    ].map(Number));

    for (const item of candidate.payment_items ?? []) {
      const paymentId = Number(item.paymentId ?? item.payment_id);
      const settlementStatus = String(
        item.settlementStatus ?? item.settlement_status ?? "unsettled",
      ).toLowerCase();
      const settlementDate = String(
        candidate.estimated_settlement_date
        ?? item.expectedSettlementDate
        ?? item.expected_settlement_date
        ?? "",
      ).slice(0, 10);

      if (
        Number.isSafeInteger(paymentId)
        && paymentId > 0
        && settlementDate
        && settlementStatus !== "unsettled"
        && !blockedPaymentIds.has(paymentId)
        && !payments.has(paymentId)
      ) {
        payments.set(paymentId, {
          paymentId,
          paymentNumber: item.payment_number ?? item.paymentNumber ?? `SCPAY-SC-${paymentId}`,
          settlementDate,
        });
      }
    }
  }

  return Array.from(payments.values());
}

export function groupQrisResettablePaymentsByDate(
  payments: QrisResettablePayment[],
): Array<{ settlementDate: string; payments: QrisResettablePayment[] }> {
  const groups = new Map<string, QrisResettablePayment[]>();
  for (const payment of payments) {
    const existing = groups.get(payment.settlementDate) ?? [];
    existing.push(payment);
    groups.set(payment.settlementDate, existing);
  }

  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([settlementDate, groupedPayments]) => ({
      settlementDate,
      payments: groupedPayments,
    }));
}

export interface QrisBulkResetResult {
  succeededPaymentIds: number[];
  failedPaymentIds: number[];
}

export async function resetQrisPaymentsSequentially(
  payments: QrisResettablePayment[],
  resetPayment: (paymentId: number) => Promise<unknown>,
): Promise<QrisBulkResetResult> {
  const result: QrisBulkResetResult = {
    succeededPaymentIds: [],
    failedPaymentIds: [],
  };

  for (const payment of payments) {
    try {
      await resetPayment(payment.paymentId);
      result.succeededPaymentIds.push(payment.paymentId);
    } catch {
      result.failedPaymentIds.push(payment.paymentId);
    }
  }

  return result;
}

export interface QrisResetAuditRow {
  id?: number | string | null;
  created_at?: string | null;
  action?: string | null;
  module?: string | null;
  user_email?: string | null;
  reference_id?: string | number | null;
  old_data?: unknown;
  new_data?: unknown;
  before_data?: unknown;
  after_data?: unknown;
  details?: unknown;
  metadata?: unknown;
}

export interface QrisResetHistoryEntry {
  id: string;
  createdAt: string | null;
  settlementDate: string | null;
  paymentCount: number;
  userEmail: string;
  action: string;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function findDate(value: unknown): string | null {
  const object = parseObject(value);
  if (!object) return null;
  for (const key of [
    "settlementDate",
    "settlement_date",
    "expectedSettlementDate",
    "expected_settlement_date",
  ]) {
    const candidate = object[key];
    if (typeof candidate === "string" && /^\d{4}-\d{2}-\d{2}/.test(candidate)) {
      return candidate.slice(0, 10);
    }
  }
  return null;
}

function findPaymentCount(value: unknown): number | null {
  const object = parseObject(value);
  if (!object) return null;
  for (const key of ["paymentCount", "payment_count", "paymentIds", "payment_ids"]) {
    const candidate = object[key];
    if (Array.isArray(candidate)) return candidate.length;
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return Math.floor(candidate);
    }
  }
  return null;
}

export function isQrisSettlementResetAudit(row: QrisResetAuditRow): boolean {
  const serialized = JSON.stringify([
    row.action,
    row.module,
    row.reference_id,
    row.old_data,
    row.new_data,
    row.before_data,
    row.after_data,
    row.details,
    row.metadata,
  ]).toLowerCase();
  return /\b(reset|unsettle|unsettled)\b/.test(serialized)
    && /\b(qris|settlement)\b/.test(serialized);
}

export function parseQrisResetHistory(
  rows: QrisResetAuditRow[],
): QrisResetHistoryEntry[] {
  return rows
    .filter(isQrisSettlementResetAudit)
    .map((row, index) => {
      const payloads = [
        row.new_data,
        row.after_data,
        row.details,
        row.metadata,
        row.old_data,
        row.before_data,
      ];
      const settlementDate = payloads.map(findDate).find(Boolean) ?? null;
      const paymentCount = payloads.map(findPaymentCount).find((count): count is number => count != null) ?? 1;
      return {
        id: String(row.id ?? `${row.created_at ?? "unknown"}-${index}`),
        createdAt: row.created_at ?? null,
        settlementDate,
        paymentCount,
        userEmail: row.user_email ?? "Operator tidak tercatat",
        action: row.action ?? "reset settlement",
      };
    });
}

export function groupQrisResetHistoryByDate(
  entries: QrisResetHistoryEntry[],
): Array<{ settlementDate: string | null; paymentCount: number; entries: QrisResetHistoryEntry[] }> {
  const groups = new Map<string, QrisResetHistoryEntry[]>();
  for (const entry of entries) {
    const key = entry.settlementDate ?? "";
    const existing = groups.get(key) ?? [];
    existing.push(entry);
    groups.set(key, existing);
  }

  return Array.from(groups.entries())
    .sort(([left], [right]) => (right || "0000-00-00").localeCompare(left || "0000-00-00"))
    .map(([key, groupedEntries]) => ({
      settlementDate: key || null,
      paymentCount: groupedEntries.reduce((total, entry) => total + entry.paymentCount, 0),
      entries: groupedEntries,
    }));
}