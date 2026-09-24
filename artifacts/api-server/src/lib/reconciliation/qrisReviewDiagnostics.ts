import { pool } from "@workspace/db";

type QrisDiagnosticRow = Record<string, unknown> & {
  mutation_id: number;
  gross_amount: string | number | null;
  mdr_amount: string | number | null;
  other_fee_amount: string | number | null;
  bank_amount: string | number | null;
  payment_items: unknown;
  source_date: string | null;
  estimated_settlement_date: string | null;
};

function safeNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function paymentItems(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function enrichDiagnosticCandidate(candidate: QrisDiagnosticRow): Record<string, unknown> {
  const gross = safeNumber(candidate.gross_amount);
  const mdr = safeNumber(candidate.mdr_amount) ?? 0;
  const otherFee = safeNumber(candidate.other_fee_amount) ?? 0;
  const bankAmount = safeNumber(candidate.bank_amount);
  const expectedNet = gross == null ? null : gross - mdr - otherFee;
  const difference =
    expectedNet == null || bankAmount == null ? null : bankAmount - expectedNet;
  const items = paymentItems(candidate.payment_items);
  const expectedDates = items
    .map((item) => item.expectedSettlementDate ?? item.expected_settlement_date)
    .filter((value) => value != null && String(value).trim() !== "")
    .map(String);
  const settlementDate = candidate.estimated_settlement_date == null
    ? null
    : String(candidate.estimated_settlement_date).slice(0, 10);
  const bankDate = candidate.diagnostic_bank_date == null
    ? null
    : String(candidate.diagnostic_bank_date).slice(0, 10);
  const currentPaymentIds = items
    .map((item) => Number(item.paymentId ?? item.payment_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  const currentPaymentAmounts = Object.fromEntries(
    items.flatMap((item) => {
      const id = Number(item.paymentId ?? item.payment_id);
      const amount = item.grossAmount ?? item.gross_amount;
      return Number.isSafeInteger(id) && id > 0 && amount != null
        ? [[String(id), amount]]
        : [];
    }),
  );

  return {
    ...candidate,
    payment_items: items,
    current_payment_ids: currentPaymentIds,
    current_payment_amounts: currentPaymentAmounts,
    current_gross_amount: gross,
    current_expected_amount: expectedNet,
    // Historical snapshots are reviewer evidence only. Even an amount-exact
    // snapshot must never become an approval authority after the legacy
    // generator/approval path was retired.
    current_evidence_valid: false,
    diagnostic_payment_count: items.length,
    diagnostic_has_expected_dates:
      items.length > 0 && expectedDates.length === items.length,
    diagnostic_date_match:
      Boolean(bankDate && settlementDate && bankDate === settlementDate)
      && expectedDates.length === items.length
      && expectedDates.every((date) => date.slice(0, 10) === bankDate),
    diagnostic_amount_difference: difference,
    candidate_source: "historical_qris_review_snapshot",
  };
}

export async function listQrisReviewDiagnostics(options: {
  companyId?: number | null;
  mutationIds?: number[];
  limit?: number;
} = {}): Promise<Record<string, unknown>[]> {
  const filters = [
    "lower(coalesce(qris.status, '')) in ('candidate_auto_matched', 'candidate_review')",
  ];
  const values: unknown[] = [];

  if (options.companyId != null) {
    values.push(options.companyId);
    filters.push(`qris.company_id = ${values.length}`);
  }
  if (options.mutationIds?.length) {
    values.push(options.mutationIds);
    filters.push(`qris.mutation_id = any(${values.length}::int[])`);
  }

  const limit = Math.min(Math.max(options.limit ?? 500, 1), 500);
  values.push(limit);

  try {
    const result = await pool.query<QrisDiagnosticRow>(
      `select
         qris.*,
         bm.amount as bank_amount,
         bm.transaction_date::date::text as diagnostic_bank_date
       from public.qris_mutation_batch_candidates qris
       join public.bank_mutations bm on bm.id = qris.mutation_id
      where ${filters.join(" and ")}
      order by qris.updated_at desc nulls last, qris.id desc
      limit ${values.length}`,
      values,
    );
    return result.rows.map(enrichDiagnosticCandidate);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "42703") return [];
    throw error;
  }
}

/**
 * Read-only bridge for historical QRIS review snapshots.
 *
 * Standalone BizPortal keeps canonical Sport Center settlement batches as the
 * only approval authority. Historical candidate snapshots are surfaced only
 * as diagnostics so operators do not see a false "no candidate" state while
 * source payment evidence still needs canonical repair.
 */
export async function hydrateQrisReviewDiagnostics<T extends object>(
  rows: T[],
): Promise<void> {
  const mutationIds = [...new Set(
    rows
      .map((row) => Number((row as Record<string, unknown>).id))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  )];
  if (mutationIds.length === 0) return;

  const diagnostics = await listQrisReviewDiagnostics({ mutationIds });
  const byMutation = new Map<number, Record<string, unknown>[]>();
  for (const diagnostic of diagnostics) {
    const mutationId = Number(diagnostic.mutation_id);
    if (!Number.isSafeInteger(mutationId)) continue;
    const list = byMutation.get(mutationId) ?? [];
    list.push(diagnostic);
    byMutation.set(mutationId, list);
  }

  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const id = Number(record.id);
    if (!Number.isSafeInteger(id)) continue;
    const diagnostics = byMutation.get(id) ?? [];
    if (diagnostics.length === 0) continue;
    record.qris_candidate_audits = diagnostics;
    record.qris_candidate_audit = diagnostics[0] ?? null;
  }
}
