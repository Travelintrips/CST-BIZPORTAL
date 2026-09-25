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

type QrisMutationRow = {
  id: number;
  company_id: number | null;
  transaction_date: string;
  amount: string | number;
  status: string | null;
};

type QrisPaymentRow = {
  id: number;
  company_id: number;
  amount: string | number;
  payment_status: string;
  payment_method: string | null;
  provider_code: string | null;
  bank_account_id: string | null;
  expected_settlement_date: string | null;
  settlement_rule_version: string | null;
  settlement_status: string | null;
  paid_at: string | null;
  confirmed_at: string | null;
  created_at: string | null;
  booking_number: string | null;
  customer_name: string | null;
  facility_name: string | null;
  booking_date: string | null;
  start_time: string | null;
  end_time: string | null;
  mdr_rate: string | number | null;
};

const HISTORICAL_SOURCE = "historical_qris_review_snapshot";
const LIVE_SOURCE = "live_qris_review_snapshot";

function safeNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function paymentItems(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function dateOnly(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function addCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function toCents(value: number): number {
  return Math.round(money(value) * 100);
}

function paymentMdr(payment: QrisPaymentRow): number {
  const gross = safeNumber(payment.amount) ?? 0;
  const rate = safeNumber(payment.mdr_rate) ?? 0.007;
  return money(gross * rate);
}

function paymentNet(payment: QrisPaymentRow): number {
  const gross = safeNumber(payment.amount) ?? 0;
  return money(gross - paymentMdr(payment));
}

function paymentItem(payment: QrisPaymentRow): Record<string, unknown> {
  return {
    paymentId: payment.id,
    grossAmount: safeNumber(payment.amount) ?? 0,
    providerName: payment.provider_code ?? "mandiri_direct",
    paymentNumber: `SCPAY-SC-${payment.id}`,
    paymentStatus: payment.payment_status,
    settlementStatus: payment.settlement_status ?? "unsettled",
    settlementRuleVersion: payment.settlement_rule_version,
    expectedSettlementDate: payment.expected_settlement_date,
    paidAt: payment.paid_at,
    confirmedAt: payment.confirmed_at,
    bookingNumber: payment.booking_number,
    customerName: payment.customer_name,
    facilityName: payment.facility_name,
    bookingDate: payment.booking_date,
    startTime: payment.start_time,
    endTime: payment.end_time,
    paymentMethod: payment.payment_method,
  };
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
    candidate_source: HISTORICAL_SOURCE,
  };
}

async function loadHistoricalDiagnostics(options: {
  companyId?: number | null;
  mutationIds?: number[];
  limit?: number;
}): Promise<Record<string, unknown>[]> {
  const filters = [
    "lower(coalesce(qris.status, '')) in ('candidate_auto_matched', 'candidate_review')",
  ];
  const values: unknown[] = [];

  if (options.companyId != null) {
    values.push(options.companyId);
    filters.push(`qris.company_id = $${values.length}`);
  }
  if (options.mutationIds?.length) {
    values.push(options.mutationIds);
    filters.push(`qris.mutation_id = any($${values.length}::int[])`);
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
      limit $${values.length}`,
      values,
    );
    return result.rows.map(enrichDiagnosticCandidate);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "42703") return [];
    throw error;
  }
}

async function loadRequestedMutationScope(
  mutationIds: number[],
): Promise<Array<{ id: number; company_id: number | null }>> {
  if (mutationIds.length === 0) return [];
  const result = await pool.query<{ id: number; company_id: number | null }>(
    `select id, company_id
       from public.bank_mutations
      where id = any($1::int[])`,
    [mutationIds],
  );
  return result.rows;
}

async function loadOpenQrisMutations(companyIds: number[]): Promise<QrisMutationRow[]> {
  if (companyIds.length === 0) return [];
  const result = await pool.query<QrisMutationRow>(
    `select
       bm.id,
       bm.company_id,
       bm.transaction_date::date::text as transaction_date,
       bm.amount,
       bm.status
     from public.bank_mutations bm
     where bm.company_id = any($1::int[])
       and upper(coalesce(bm.direction, '')) = 'IN'
       and lower(coalesce(bm.status::text, '')) not in ('approved', 'posted', 'void', 'rejected')
       and not exists (
         select 1
           from public.bank_reconciliation_matches brm
          where brm.mutation_id = bm.id
            and lower(coalesce(brm.status::text, '')) in ('candidate', 'approved', 'posted')
       )
       and (
         upper(coalesce(bm.description, '')) like '%QRTRAVELI%'
         or upper(coalesce(bm.normalized_description, '')) like '%QRTRAVELI%'
         or upper(coalesce(bm.provider_name, '')) like '%QRIS%'
         or upper(coalesce(bm.description, '')) like '%QRIS%'
       )
     order by bm.transaction_date, bm.id`,
    [companyIds],
  );
  return result.rows;
}

async function loadLiveQrisPayments(
  companyIds: number[],
  fromDate: string,
  toDate: string,
): Promise<QrisPaymentRow[]> {
  if (companyIds.length === 0) return [];
  const result = await pool.query<QrisPaymentRow>(
    `select
       sp.id,
       sp.company_id,
       sp.amount,
       sp.status::text as payment_status,
       sp.payment_method,
       lower(nullif(btrim(sp.payment_provider::text), '')) as provider_code,
       sp.bank_account_id::text as bank_account_id,
       sp.expected_settlement_date::text as expected_settlement_date,
       sp.settlement_rule_version,
       sp.settlement_status::text as settlement_status,
       sp.paid_at::text as paid_at,
       sp.confirmed_at::text as confirmed_at,
       sp.created_at::text as created_at,
       sb.order_number as booking_number,
       sb.customer_name,
       facility.name as facility_name,
       sb.booking_date::text as booking_date,
       sb.start_time::text as start_time,
       sb.end_time::text as end_time,
       coalesce(config.mdr_rate, 0.007)::numeric as mdr_rate
     from sport_center.sport_payments sp
     join sport_center.sport_bookings sb on sb.id = sp.booking_id
     left join sport_center.facilities facility on facility.id = sb.facility_id
     left join lateral (
       select settlement_config.mdr_rate
         from sport_center.payment_settlement_configs settlement_config
        where settlement_config.company_id = sp.company_id
          and settlement_config.provider_code = lower(nullif(btrim(sp.payment_provider::text), ''))
          and (
            settlement_config.rule_version = sp.settlement_rule_version
            or (
              sp.settlement_rule_version is null
              and settlement_config.is_active = true
              and settlement_config.effective_from <= coalesce(nullif(sp.expected_settlement_date, '')::date, current_date)
              and (
                settlement_config.effective_until is null
                or settlement_config.effective_until >= coalesce(nullif(sp.expected_settlement_date, '')::date, current_date)
              )
            )
          )
        order by
          (settlement_config.rule_version = sp.settlement_rule_version) desc,
          settlement_config.effective_from desc,
          settlement_config.id desc
        limit 1
     ) config on true
     where sp.company_id = any($1::int[])
       and lower(coalesce(sp.status::text, '')) = 'confirmed'
       and lower(coalesce(sp.payment_method, '')) = 'qris'
       and lower(coalesce(sp.settlement_status::text, 'unsettled')) = 'unsettled'
       and nullif(sp.expected_settlement_date, '')::date between $2::date and $3::date
       and not exists (
         select 1
           from sport_center.payment_settlement_items psi
           join sport_center.payment_settlement_batches psb
             on psb.id = psi.settlement_id
          where psi.payment_id = sp.id
            and psi.item_status = 'active'
            and lower(coalesce(psb.status::text, '')) in ('draft', 'calculated', 'posted', 'reconciled')
       )
     order by sp.expected_settlement_date, sp.id`,
    [companyIds, fromDate, toDate],
  );
  return result.rows;
}

function findExactPaymentSubset(
  payments: QrisPaymentRow[],
  targetAmount: number,
): QrisPaymentRow[] | null {
  const target = toCents(targetAmount);
  if (target <= 0 || payments.length === 0) return null;

  const states = new Map<number, number[]>([[0, []]]);
  const maxStates = 100_000;

  for (const payment of payments) {
    const net = toCents(paymentNet(payment));
    if (net <= 0) continue;
    const snapshot = [...states.entries()];
    for (const [sum, ids] of snapshot) {
      const next = sum + net;
      if (next > target || states.has(next)) continue;
      const nextIds = [...ids, payment.id];
      if (next === target) {
        const selected = new Set(nextIds);
        return payments.filter((candidate) => selected.has(candidate.id));
      }
      states.set(next, nextIds);
      if (states.size >= maxStates) break;
    }
    if (states.size >= maxStates) break;
  }
  return null;
}

function synthesizeDiagnostic(
  mutation: QrisMutationRow,
  selected: QrisPaymentRow[],
  exactAmountMatch: boolean,
): Record<string, unknown> {
  const bankAmount = safeNumber(mutation.amount) ?? 0;
  const gross = money(selected.reduce(
    (sum, payment) => sum + (safeNumber(payment.amount) ?? 0),
    0,
  ));
  const mdr = money(selected.reduce((sum, payment) => sum + paymentMdr(payment), 0));
  const net = money(gross - mdr);
  const difference = money(bankAmount - net);
  const settlementDate = dateOnly(mutation.transaction_date);
  const expectedDates = selected
    .map((payment) => dateOnly(payment.expected_settlement_date))
    .filter((value): value is string => Boolean(value));
  const currentPaymentAmounts = Object.fromEntries(
    selected.map((payment) => [String(payment.id), safeNumber(payment.amount) ?? 0]),
  );

  return {
    mutation_id: mutation.id,
    company_id: mutation.company_id,
    provider_code: "mandiri_direct",
    mutation_source_classification: "QRIS_LIVE_REVIEW",
    source_date: settlementDate,
    estimated_settlement_date: settlementDate,
    gross_amount: gross,
    mdr_amount: mdr,
    other_fee_amount: 0,
    net_amount: net,
    observed_deduction: mdr,
    effective_deduction_rate: gross > 0 ? mdr / gross : null,
    reconciliation_status: "REVIEW",
    confidence: exactAmountMatch ? 0.95 : selected.length > 0 ? 0.6 : 0.2,
    review_reason: exactAmountMatch
      ? "Payment QRIS live membentuk nominal netto yang tepat sama dengan mutasi bank. Kandidat ini read-only sampai settlement canonical dibuat."
      : selected.length > 0
        ? `Payment QRIS live ditemukan, tetapi netto kandidat berbeda Rp ${Math.abs(difference).toLocaleString("id-ID")} dari mutasi bank. Periksa payment yang belum tercatat atau tanggal settlement.`
        : "Belum ada payment QRIS live yang dapat dipakai untuk mutasi ini. Kandidat diagnostik tetap ditampilkan agar gap sumber terlihat.",
    payment_items: selected.map(paymentItem),
    current_payment_ids: selected.map((payment) => payment.id),
    current_payment_amounts: currentPaymentAmounts,
    current_gross_amount: gross,
    current_expected_amount: net,
    current_evidence_valid: false,
    diagnostic_payment_count: selected.length,
    diagnostic_has_expected_dates:
      selected.length > 0 && expectedDates.length === selected.length,
    diagnostic_date_match:
      selected.length > 0
      && settlementDate != null
      && expectedDates.every((date) =>
        date === settlementDate || date === addCalendarDays(settlementDate, -1)
      ),
    diagnostic_amount_difference: difference,
    diagnostic_bank_date: settlementDate,
    candidate_source: LIVE_SOURCE,
    status: "candidate_review",
    generated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function currentPaymentIds(candidate: Record<string, unknown>): number[] {
  if (Array.isArray(candidate.current_payment_ids)) {
    return candidate.current_payment_ids
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0);
  }
  return paymentItems(candidate.payment_items)
    .map((item) => Number(item.paymentId ?? item.payment_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

async function synthesizeLiveReviewDiagnostics(
  openMutations: QrisMutationRow[],
  historicalDiagnostics: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (openMutations.length === 0) return [];

  const dates = openMutations
    .map((mutation) => dateOnly(mutation.transaction_date))
    .filter((value): value is string => Boolean(value));
  const companyIds = [...new Set(
    openMutations
      .map((mutation) => mutation.company_id)
      .filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0),
  )];
  if (dates.length === 0 || companyIds.length === 0) return [];

  const fromDate = addCalendarDays(dates.sort()[0]!, -1);
  const toDate = dates.sort().at(-1)!;
  const payments = await loadLiveQrisPayments(companyIds, fromDate, toDate);
  const historicalByMutation = new Map<number, Record<string, unknown>[]>();
  for (const diagnostic of historicalDiagnostics) {
    const mutationId = Number(diagnostic.mutation_id);
    if (!Number.isSafeInteger(mutationId)) continue;
    const list = historicalByMutation.get(mutationId) ?? [];
    list.push(diagnostic);
    historicalByMutation.set(mutationId, list);
  }

  const reservedPaymentIds = new Set<number>();
  const synthesized: Record<string, unknown>[] = [];
  const mutations = [...openMutations].sort((left, right) => {
    const dateCompare = String(left.transaction_date).localeCompare(String(right.transaction_date));
    return dateCompare !== 0 ? dateCompare : left.id - right.id;
  });

  for (const mutation of mutations) {
    const existing = historicalByMutation.get(mutation.id) ?? [];
    const exactHistorical = existing.find((diagnostic) => {
      const storedDifference = safeNumber(diagnostic.diagnostic_amount_difference);
      if (storedDifference != null) return Math.abs(storedDifference) < 1;
      const storedNet = safeNumber(
        diagnostic.current_expected_amount ?? diagnostic.net_amount,
      );
      const bankAmount = safeNumber(mutation.amount);
      return storedNet != null
        && bankAmount != null
        && Math.abs(bankAmount - storedNet) < 1;
    });
    if (exactHistorical) {
      for (const paymentId of currentPaymentIds(exactHistorical)) {
        reservedPaymentIds.add(paymentId);
      }
      continue;
    }

    const mutationDate = dateOnly(mutation.transaction_date);
    if (!mutationDate || mutation.company_id == null) continue;
    const previousDate = addCalendarDays(mutationDate, -1);
    const available = payments.filter((payment) =>
      payment.company_id === mutation.company_id
      && !reservedPaymentIds.has(payment.id)
      && (
        dateOnly(payment.expected_settlement_date) === mutationDate
        || dateOnly(payment.expected_settlement_date) === previousDate
      )
    );
    const sameDate = available.filter(
      (payment) => dateOnly(payment.expected_settlement_date) === mutationDate,
    );
    const bankAmount = safeNumber(mutation.amount) ?? 0;

    const exactSameDate = findExactPaymentSubset(sameDate, bankAmount);
    const exactExpanded = exactSameDate ?? findExactPaymentSubset(available, bankAmount);
    const selected = exactExpanded
      ?? (sameDate.length > 0
        ? sameDate
        : available.filter(
          (payment) => dateOnly(payment.expected_settlement_date) === previousDate,
        ));
    const exact = exactExpanded != null;

    for (const payment of selected) reservedPaymentIds.add(payment.id);
    synthesized.push(synthesizeDiagnostic(mutation, selected, exact));
  }

  return synthesized;
}

export async function listQrisReviewDiagnostics(options: {
  companyId?: number | null;
  mutationIds?: number[];
  limit?: number;
} = {}): Promise<Record<string, unknown>[]> {
  const requestedIds = [...new Set(
    (options.mutationIds ?? [])
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  )];
  const requestedScope = requestedIds.length > 0
    ? await loadRequestedMutationScope(requestedIds)
    : [];
  const companyIds = options.companyId != null
    ? [options.companyId]
    : [...new Set(
      requestedScope
        .map((row) => row.company_id)
        .filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0),
    )];

  const effectiveCompanyIds = companyIds.length > 0 ? companyIds : [1];
  const openMutations = await loadOpenQrisMutations(effectiveCompanyIds);
  const openMutationIds = openMutations.map((mutation) => mutation.id);
  const historicalForOpen = openMutationIds.length > 0
    ? await loadHistoricalDiagnostics({
      mutationIds: openMutationIds,
      limit: 500,
    })
    : [];
  const synthetic = await synthesizeLiveReviewDiagnostics(
    openMutations,
    historicalForOpen,
  );

  const requestedHistorical = await loadHistoricalDiagnostics({
    companyId: options.companyId,
    mutationIds: requestedIds.length > 0 ? requestedIds : undefined,
    limit: Math.min(Math.max(options.limit ?? 500, 1), 500),
  });

  const merged = new Map<string, Record<string, unknown>>();
  const syntheticMutationIds = new Set(
    synthetic
      .map((diagnostic) => Number(diagnostic.mutation_id))
      .filter((id) => Number.isSafeInteger(id)),
  );
  for (const diagnostic of [...synthetic, ...requestedHistorical, ...historicalForOpen]) {
    const mutationId = Number(diagnostic.mutation_id);
    if (!Number.isSafeInteger(mutationId)) continue;
    if (requestedIds.length > 0 && !requestedIds.includes(mutationId)) continue;
    if (
      options.companyId != null
      && Number(diagnostic.company_id) !== Number(options.companyId)
    ) continue;
    const source = String(diagnostic.candidate_source ?? "unknown");
    if (source === HISTORICAL_SOURCE && syntheticMutationIds.has(mutationId)) {
      continue;
    }
    const id = diagnostic.id == null ? "synthetic" : String(diagnostic.id);
    merged.set(`${mutationId}:${source}:${id}`, diagnostic);
  }

  const limit = Math.min(Math.max(options.limit ?? 500, 1), 500);
  return [...merged.values()]
    .sort((left, right) => {
      const leftMutation = Number(left.mutation_id) || 0;
      const rightMutation = Number(right.mutation_id) || 0;
      if (leftMutation !== rightMutation) return rightMutation - leftMutation;
      return Number(right.id ?? 0) - Number(left.id ?? 0);
    })
    .slice(0, limit);
}

/**
 * Read-only bridge for historical and live QRIS review snapshots.
 *
 * Standalone BizPortal keeps canonical Sport Center settlement batches as the
 * only approval authority. Review snapshots are surfaced only as diagnostics
 * so operators never see a false "no candidate" state while source payment
 * evidence still needs canonical repair or completion.
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

  const diagnostics = await listQrisReviewDiagnostics({ mutationIds, limit: 500 });
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
    const mutationDiagnostics = byMutation.get(id) ?? [];
    if (mutationDiagnostics.length === 0) continue;
    record.qris_candidate_audits = mutationDiagnostics;
    record.qris_candidate_audit = mutationDiagnostics[0] ?? null;
  }
}
