import { pool } from "@workspace/db";

type MutationWithQrisDiagnostics = {
  id?: unknown;
  qris_candidate_audits?: unknown;
  qris_candidate_audit?: unknown;
};

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

/**
 * Read-only bridge for historical QRIS review snapshots.
 *
 * Standalone BizPortal keeps canonical Sport Center settlement batches as the
 * only approval authority. Historical candidate snapshots are surfaced only
 * as diagnostics so operators do not see a false "no candidate" state while
 * source payment evidence still needs canonical repair.
 */
export async function hydrateQrisReviewDiagnostics(
  rows: MutationWithQrisDiagnostics[],
): Promise<void> {
  const mutationIds = [...new Set(
    rows
      .map((row) => Number(row.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  )];
  if (mutationIds.length === 0) return;

  let result: { rows: QrisDiagnosticRow[] };
  try {
    result = await pool.query<QrisDiagnosticRow>(
      `select
         qris.*,
         bm.amount as bank_amount,
         bm.transaction_date::date::text as diagnostic_bank_date
       from public.qris_mutation_batch_candidates qris
       join public.bank_mutations bm on bm.id = qris.mutation_id
      where qris.mutation_id = any($1::int[])
        and lower(coalesce(qris.status, '')) in ('candidate_auto_matched', 'candidate_review')
      order by qris.mutation_id, qris.updated_at desc nulls last, qris.id desc`,
      [mutationIds],
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "42703") return;
    throw error;
  }

  const byMutation = new Map<number, Record<string, unknown>[]>();
  for (const candidate of result.rows) {
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

    const enriched: Record<string, unknown> = {
      ...candidate,
      payment_items: items,
      current_payment_ids: currentPaymentIds,
      current_payment_amounts: currentPaymentAmounts,
      current_gross_amount: gross,
      current_expected_amount: expectedNet,
      current_evidence_valid: difference != null && Math.abs(difference) < 1,
      diagnostic_payment_count: items.length,
      diagnostic_has_expected_dates:
        items.length > 0 && expectedDates.length === items.length,
      diagnostic_date_match:
        Boolean(bankDate && settlementDate && bankDate === settlementDate)
        && expectedDates.length === items.length
        && expectedDates.every((date) => date.slice(0, 10) === bankDate),
      diagnostic_amount_difference: difference,
      candidate_source: candidate.candidate_source ?? "historical_qris_review_snapshot",
    };

    const list = byMutation.get(candidate.mutation_id) ?? [];
    list.push(enriched);
    byMutation.set(candidate.mutation_id, list);
  }

  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id)) continue;
    const diagnostics = byMutation.get(id) ?? [];
    if (diagnostics.length === 0) continue;
    row.qris_candidate_audits = diagnostics;
    row.qris_candidate_audit = diagnostics[0] ?? null;
  }
}
