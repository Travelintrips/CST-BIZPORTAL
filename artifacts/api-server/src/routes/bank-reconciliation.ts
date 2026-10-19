import { Router, type IRouter, type Request } from "express";
import { pool } from "@workspace/db";
import { evaluateReconRules, type ReconRule } from "../lib/reconciliation/reconRuleEngine";
import {
  hydrateQrisReviewDiagnostics,
  listQrisReviewDiagnostics,
} from "../lib/reconciliation/qrisReviewDiagnostics";
import { inspectSpreadsheet } from "../lib/google-sheets";
import {
  syncAllBankSheetConfigs,
  syncOneBankSheetConfig,
} from "../lib/bank-sheet-sync";
import {
  getDevSession,
  getProductionSession,
  getProductionUser,
  isDevelopmentEnvironment,
} from "./dev-auth";

interface SheetConfigInput {
  company_id?: number | null;
  label?: string;
  sheet_id?: string;
  bank_account_id?: number | null;
  bank_account_number?: string | null;
  bank_name?: string | null;
  tab_name?: string;
  is_active?: boolean;
}

interface SheetConfigRow {
  id: number;
  company_id: number | null;
  company_name: string | null;
  label: string;
  sheet_id: string;
  tab_name: string;
  bank_account_id: number | null;
  bank_account_number: string | null;
  bank_name: string | null;
  account_name: string | null;
  account_coa_code: string | null;
  account_coa_name: string | null;
  is_active: boolean | null;
  last_synced_at: Date | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
}

const router: IRouter = Router();

type ApprovalClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: any[],
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

interface ApprovalBody {
  match_id?: unknown;
  candidate_type?: unknown;
  candidate_id?: unknown;
  candidate_source?: unknown;
  note?: unknown;
  manual_coa_code?: unknown;
}

interface ApprovalActor {
  email: string;
  companyId: number | null;
}

type MatchingMode = "new" | "retry_unmatched" | "rematch_non_final";

interface MatchingMutation {
  id: number;
  amount: string;
  direction: string;
  transaction_date: string;
  description: string;
  normalized_description: string | null;
  provider_order_id: string | null;
  company_id: number | null;
  status: string;
  bank_account_id: string | null;
  bank_reference: string | null;
  provider_name: string | null;
  uploaded_proof_url: string | null;
  review_code: string | null;
}

interface LocalMatchingSummary {
  processed: number;
  failed: number;
  auto_matched: number;
  auto_posted: number;
  manual_review: number;
  unmatched: number;
  rule_matched: number;
  ecf_matched: number;
}

interface MatchingJobState {
  running: boolean;
  status: "running" | "completed" | "failed";
  total: number;
  processed: number;
  failed: number;
  summary: LocalMatchingSummary;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const matchingJobsByCompany = new Map<string, MatchingJobState>();

function matchingJobKey(actor: ApprovalActor): string {
  return actor.companyId == null ? "global" : String(actor.companyId);
}

async function claimMatchingJob(jobKey: string, state: MatchingJobState): Promise<boolean> {
  const result = await pool.query<{ job_key: string }>(
    `insert into public.reconciliation_matching_jobs
      (job_key,status,total_count,processed_count,failed_count,summary,error_message,started_at,completed_at,updated_at)
     values ($1,'running',$2,$3,$4,$5::jsonb,null,$6,null,now())
     on conflict (job_key) do update set
       status='running',
       total_count=excluded.total_count,
       processed_count=excluded.processed_count,
       failed_count=excluded.failed_count,
       summary=excluded.summary,
       error_message=null,
       started_at=excluded.started_at,
       completed_at=null,
       updated_at=now()
     where public.reconciliation_matching_jobs.status <> 'running'
        or public.reconciliation_matching_jobs.updated_at < now() - interval '5 minutes'
     returning job_key`,
    [
      jobKey,
      state.total,
      state.processed,
      state.failed,
      JSON.stringify(state.summary),
      state.started_at,
    ],
  );
  return Boolean(result.rows[0]?.job_key);
}

async function touchMatchingJobState(jobKey: string, state: MatchingJobState): Promise<void> {
  await pool.query(
    `update public.reconciliation_matching_jobs
        set total_count=$2,
            processed_count=$3,
            failed_count=$4,
            summary=$5::jsonb,
            updated_at=now()
      where job_key=$1 and status='running'`,
    [
      jobKey,
      state.total,
      state.processed,
      state.failed,
      JSON.stringify(state.summary),
    ],
  );
}

async function persistMatchingJobState(jobKey: string, state: MatchingJobState): Promise<void> {
  await pool.query(
    `insert into public.reconciliation_matching_jobs
      (job_key,status,total_count,processed_count,failed_count,summary,error_message,started_at,completed_at,updated_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,now())
     on conflict (job_key) do update set
       status=excluded.status,
       total_count=excluded.total_count,
       processed_count=excluded.processed_count,
       failed_count=excluded.failed_count,
       summary=excluded.summary,
       error_message=excluded.error_message,
       started_at=excluded.started_at,
       completed_at=excluded.completed_at,
       updated_at=now()`,
    [
      jobKey,
      state.status,
      state.total,
      state.processed,
      state.failed,
      JSON.stringify(state.summary),
      state.error,
      state.started_at,
      state.finished_at,
    ],
  );
}

async function loadPersistedMatchingJobState(jobKey: string): Promise<MatchingJobState | null> {
  const result = await pool.query<any>(
    `select status,total_count,processed_count,failed_count,summary,error_message,
            started_at,completed_at,updated_at
       from public.reconciliation_matching_jobs
      where job_key=$1
      limit 1`,
    [jobKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  const staleRunning =
    row.status === "running"
    && row.updated_at
    && Date.now() - new Date(row.updated_at).getTime() > 5 * 60 * 1000;
  const status: MatchingJobState["status"] =
    staleRunning || row.status === "failed"
      ? "failed"
      : row.status === "completed"
        ? "completed"
        : "running";
  return {
    running: status === "running",
    status,
    total: Number(row.total_count ?? 0),
    processed: Number(row.processed_count ?? 0),
    failed: Number(row.failed_count ?? 0),
    summary: { ...emptyLocalMatchingSummary(), ...(row.summary ?? {}) },
    error: staleRunning
      ? "AI Matching worker terhenti sebelum selesai. Jalankan AI Matching lagi."
      : row.error_message == null
        ? null
        : String(row.error_message),
    started_at: row.started_at ? new Date(row.started_at).toISOString() : new Date(0).toISOString(),
    finished_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

function emptyLocalMatchingSummary(): LocalMatchingSummary {
  return {
    processed: 0,
    failed: 0,
    auto_matched: 0,
    auto_posted: 0,
    manual_review: 0,
    unmatched: 0,
    rule_matched: 0,
    ecf_matched: 0,
  };
}

interface LocalMatchCandidate {
  candidateType: "sport_payment" | "sport_group_payment" | "sport_company_invoice" | "tenant_invoice" | "vendor_invoice" | "qris_settlement" | "internal_transfer" | "payroll_item" | "cash_advance";
  candidateId: number;
  score: number;
  amountMatch: boolean;
  dateMatch: boolean;
  referenceMatch: boolean;
  nameMatch: boolean;
  reason: string;
  customerName?: string | null;
  orderRef?: string | null;
}

function localCandidateSource(candidateType: LocalMatchCandidate["candidateType"]): string {
  switch (candidateType) {
    case "sport_payment":
      return "sport_center.sport_payments";
    case "sport_group_payment":
      return "sport_center.booking_groups";
    case "sport_company_invoice":
      return "sport_center.company_invoices";
    case "tenant_invoice":
      return "public.tenant_payments";
    case "vendor_invoice":
      return "public.vendor_invoices";
    case "qris_settlement":
      return "sport_center.payment_settlement_batches";
    case "internal_transfer":
      return "public.bank_mutations";
    case "payroll_item":
      return "public.payroll_items";
    case "cash_advance":
      return "public.cash_advances";
  }
}

class ApprovalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

function textValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

function calendarDateValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const text = value.trim();
    const isoDate = text.match(/^(\d{4}-\d{2}-\d{2})(?:T|\s|$)/);
    if (isoDate) return isoDate[1];
  }

  const parsed = value instanceof Date
    ? value
    : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const date = `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function safeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function hasQrisBankEvidenceForAutoPost(mutation: MatchingMutation): boolean {
  const values = [
    mutation.provider_name,
    mutation.provider_order_id,
    mutation.description,
    mutation.normalized_description,
  ];
  const compactValues = values.map(value =>
    String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
  );
  // InhouseTrf is an explicit bank-transfer marker and wins over a stale
  // QRIS-like token in the same statement description.
  if (compactValues.some(value => value.includes("INHOUSETRF"))) return false;
  return values.some(value => {
    const normalized = String(value ?? "").trim().toUpperCase();
    return normalized.includes("QRIS")
      || /QR[A-Z0-9]{4,}/.test(normalized)
      || /\bQR\s*(?:CODE|PAY|PAYMENT)\b/.test(normalized);
  });
}

async function getApprovalActor(request: Request): Promise<ApprovalActor | null> {
  const allowedRoles = new Set(["admin", "owner", "finance", "accounting", "accountant", "super_admin"]);

  if (isDevelopmentEnvironment()) {
    const user = getDevSession(request);
    if (!user || !allowedRoles.has(user.role.toLowerCase())) return null;
    return { email: user.email, companyId: user.companyId };
  }

  const session = getProductionSession(request);
  if (!session) return null;
  const user = await getProductionUser(session);
  if (!user || !allowedRoles.has(user.role.toLowerCase())) return null;
  return { email: user.email, companyId: user.companyId };
}

function normalizeMatchText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchingTokens(value: unknown): Set<string> {
  return new Set(
    normalizeMatchText(value)
      .split(/\s+/)
      .filter((token) => token.length >= 4),
  );
}

function tokenOverlap(left: unknown, right: unknown): boolean {
  const leftTokens = matchingTokens(left);
  if (leftTokens.size === 0) return false;
  for (const token of matchingTokens(right)) {
    if (leftTokens.has(token)) return true;
  }
  return false;
}

const PAYROLL_MONTHS: Record<string, number> = {
  januari: 1, jan: 1,
  februari: 2, feb: 2,
  maret: 3, mar: 3,
  april: 4, apr: 4,
  mei: 5,
  juni: 6, jun: 6,
  juli: 7, jul: 7,
  agustus: 8, agu: 8, ags: 8,
  september: 9, sep: 9,
  oktober: 10, okt: 10,
  november: 11, nov: 11,
  desember: 12, des: 12,
};

function payrollPeriodFromMutation(
  description: unknown,
  transactionDate: unknown,
): { month: number; year: number } | null {
  const text = normalizeMatchText(description);
  const dateText = calendarDateValue(transactionDate);
  if (!dateText) return null;
  const transactionYear = Number(dateText.slice(0, 4));
  const transactionMonth = Number(dateText.slice(5, 7));
  const explicitYearMatch = text.match(/\b(20\d{2})\b/);
  const explicitYear = explicitYearMatch ? Number(explicitYearMatch[1]) : null;
  for (const [label, month] of Object.entries(PAYROLL_MONTHS)) {
    if (new RegExp(`\\b${label}\\b`, "i").test(text)) {
      return { month, year: explicitYear ?? transactionYear };
    }
  }
  // Descriptions such as "gaji cariu" omit the payroll month. Salary
  // disbursements are normally paid in the following calendar month, so the
  // previous month is the safe deterministic fallback.
  const fallbackMonth = transactionMonth === 1 ? 12 : transactionMonth - 1;
  const fallbackYear = transactionMonth === 1 ? transactionYear - 1 : transactionYear;
  return { month: fallbackMonth, year: explicitYear ?? fallbackYear };
}

function candidateRelevantToRule(
  rule: ReconRule,
  candidate: LocalMatchCandidate,
): boolean {
  switch (rule.targetType) {
    case "payroll":
      return candidate.candidateType === "payroll_item";
    case "employee_advance":
      return candidate.candidateType === "cash_advance";
    case "vendor_payment":
      return candidate.candidateType === "vendor_invoice";
    case "internal_transfer":
      return candidate.candidateType === "internal_transfer";
    case "customer_payment":
      return [
        "sport_payment",
        "sport_group_payment",
        "sport_company_invoice",
        "tenant_invoice",
      ].includes(candidate.candidateType);
    default:
      return true;
  }
}

async function isKasBesarScReconciliationAccount(
  client: ApprovalClient,
  companyId: number,
  bankAccountId: string | null,
): Promise<boolean> {
  if (!bankAccountId) return false;
  const result = await client.query<{ blocked: boolean }>(
    `select exists (
       select 1
         from public.company_bank_accounts cba
         join public.chart_of_accounts coa
           on coa.id = cba.coa_id
          and coa.company_id = cba.company_id
        where cba.company_id = $1
          and (
            cba.id::text = $2::text
            or (
              nullif(regexp_replace(coalesce(cba.account_number, ''), '[^0-9]', '', 'g'), '') is not null
              and regexp_replace(coalesce(cba.account_number, ''), '[^0-9]', '', 'g') =
                  regexp_replace(coalesce($2::text, ''), '[^0-9]', '', 'g')
            )
          )
          and upper(trim(coalesce(coa.code, ''))) = '1-1010-CST'
     ) as blocked`,
    [companyId, bankAccountId],
  );
  return result.rows[0]?.blocked === true;
}

async function loadLocalMatchCandidates(
  client: ApprovalClient,
  mutation: MatchingMutation,
): Promise<LocalMatchCandidate[]> {
  if (mutation.company_id == null) return [];

  const amount = Number(mutation.amount);
  if (!Number.isFinite(amount) || amount <= 0) return [];
  const date = calendarDateValue(mutation.transaction_date);
  if (!date) return [];
  const direction = String(mutation.direction ?? "").toUpperCase();
  const candidates: LocalMatchCandidate[] = [];
  const vendorInvoiceMatchBlocked =
    direction === "OUT"
    && await isKasBesarScReconciliationAccount(
      client,
      mutation.company_id,
      mutation.bank_account_id,
    );

  if (direction === "IN") {
    // Pair incoming cash/bank mutations with an already-posted outgoing mutation
    // from another company-owned account only when the source journal already
    // proves the same internal transfer (Dr target cash/bank, Cr source bank).
    // This prevents an incoming transfer from being misclassified as revenue
    // and prevents a second accounting journal from being created.
    if (mutation.bank_account_id) {
      try {
        const internalTransfers = await client.query<{
          id: number;
          transaction_date: string;
          description: string;
          date_distance_days: number;
          source_account_name: string | null;
        }>(
          `select source.id,
                  source.transaction_date::text,
                  source.description,
                  abs(source.transaction_date - $3::date)::integer as date_distance_days,
                  source_account.name as source_account_name
             from public.bank_mutations source
             join public.company_bank_accounts target_account
               on target_account.company_id = $1
              and coalesce(target_account.is_active, true) = true
              and (
                target_account.id::text = $4::text
                or target_account.account_number::text = $4::text
                or regexp_replace(coalesce(target_account.account_number, ''), '[^0-9]', '', 'g') =
                   regexp_replace(coalesce($4::text, ''), '[^0-9]', '', 'g')
              )
             join public.company_bank_accounts source_account
               on source_account.company_id = source.company_id
              and coalesce(source_account.is_active, true) = true
              and (
                source_account.id::text = source.bank_account_id::text
                or source_account.account_number::text = source.bank_account_id::text
                or regexp_replace(coalesce(source_account.account_number, ''), '[^0-9]', '', 'g') =
                   regexp_replace(coalesce(source.bank_account_id::text, ''), '[^0-9]', '', 'g')
              )
             join public.accounting_entries source_entry
               on source_entry.id = source.journal_entry_id
              and source_entry.company_id = source.company_id
              and source_entry.status::text = 'posted'
              and coalesce(source_entry.is_voided, false) = false
            where source.company_id = $1
              and source.id <> $5
              and source.direction = 'OUT'
              and source.status = 'posted'
              and source.reconciliation_status = 'reconciled'
              and coalesce(source.accounting_posted, false) = true
              and source.journal_entry_id is not null
              and source_account.id <> target_account.id
              and abs(source.amount::numeric - $2::numeric) < 0.01
              and source.transaction_date between ($3::date - 1) and ($3::date + 1)
              and (
                source.linked_transaction_id is null
                or (
                  source.linked_transaction_type = 'internal_transfer'
                  and source.linked_transaction_id = $5
                )
              )
              and exists (
                select 1
                  from public.accounting_entry_lines target_line
                 where target_line.entry_id = source_entry.id
                   and target_line.account_id = target_account.coa_id
                   and target_line.debit > 0
                   and abs(target_line.debit::numeric - $2::numeric) < 0.01
              )
              and exists (
                select 1
                  from public.accounting_entry_lines source_line
                 where source_line.entry_id = source_entry.id
                   and source_line.account_id = source_account.coa_id
                   and source_line.credit > 0
                   and abs(source_line.credit::numeric - $2::numeric) < 0.01
              )
              and not exists (
                select 1
                  from public.bank_reconciliation_matches brm
                 where brm.candidate_type = 'internal_transfer'
                   and brm.candidate_id = source.id
                   and brm.candidate_source = 'public.bank_mutations'
                   and brm.mutation_id <> $5
                   and brm.status in ('approved', 'posted')
              )
            order by abs(source.transaction_date - $3::date), source.id
            limit 10`,
          [mutation.company_id, amount, date, mutation.bank_account_id, mutation.id],
        );

        for (const source of internalTransfers.rows) {
          const dateDistanceDays = Number(source.date_distance_days);
          const exactDateMatch = dateDistanceDays === 0;
          candidates.push({
            candidateType: "internal_transfer",
            candidateId: Number(source.id),
            score: exactDateMatch ? 100 : 96,
            amountMatch: true,
            dateMatch: dateDistanceDays <= 1,
            referenceMatch: false,
            nameMatch: tokenOverlap(mutation.description, source.description),
            reason: exactDateMatch
              ? "Transfer internal: nominal, tanggal, rekening tujuan, dan jurnal sumber cocok."
              : "Transfer internal: nominal dan jurnal sumber cocok; tanggal dalam toleransi 1 hari.",
            customerName: source.source_account_name,
            orderRef: String(source.id),
          });
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "42P01" && code !== "42703") throw error;
      }
    }

    // Canonical QRIS settlements are the source of truth for net bank credits.
    // A QRIS bank mutation is net of MDR, so comparing it directly with one
    // sport_payments.amount drops valid candidates (for example 130,000 gross
    // less 0.7% MDR = 129,090 bank credit). Only enter this path when the bank
    // statement itself carries QRIS evidence; a same-amount bank transfer must
    // never be reclassified as a QRIS settlement by coincidence.
    if (hasQrisBankEvidenceForAutoPost(mutation)) {
      try {
        const canonicalQrisSettlements = await client.query<{
        id: number;
        amount: string;
        settlement_date: string | null;
        settlement_reference: string | null;
        description: string | null;
        date_distance_days: number;
      }>(
        `select psb.id::bigint as id,
                psb.net_amount::numeric as amount,
                psb.settlement_date::text as settlement_date,
                psb.settlement_reference,
                concat_ws(
                  ' ',
                  psb.provider_code,
                  psb.provider_name,
                  psb.settlement_reference
                ) as description,
                abs(psb.settlement_date - $3::date)::integer as date_distance_days
           from sport_center.payment_settlement_batches psb
           join public.company_bank_accounts cba
             on cba.company_id = psb.company_id
            and cba.is_active = true
            and cba.account_number::text = psb.bank_account_id::text
           join sport_center.accounting_journals sj
             on sj.id = psb.settlement_journal_id
            and sj.status::text = 'posted'
            and sj.journal_type = 'settlement'
            and sj.is_reversal = false
          where psb.company_id = $1
            and psb.status::text = 'posted'
            and psb.bank_mutation_id is null
            and psb.canonical_bank_mutation_id is null
            and abs(psb.net_amount::numeric - $2::numeric) < 0.01
            and psb.settlement_date between ($3::date - 1) and ($3::date + 1)
            and (
              $4::text is null
              or cba.id::text = $4::text
              or cba.account_number::text = $4::text
            )
            and not exists (
              select 1
                from public.bank_reconciliation_matches brm
               where brm.candidate_type = 'qris_settlement'
                 and brm.candidate_id = psb.id
                 and brm.candidate_source = 'sport_center.payment_settlement_batches'
                 and brm.status in ('approved', 'posted')
            )
          order by abs(psb.settlement_date - $3::date), psb.id`,
        [mutation.company_id, amount, date, mutation.bank_account_id],
      );

        for (const settlement of canonicalQrisSettlements.rows) {
          const referenceMatch =
            Boolean(mutation.provider_order_id) &&
            normalizeMatchText(mutation.provider_order_id) ===
              normalizeMatchText(settlement.settlement_reference);
          const nameMatch = tokenOverlap(mutation.description, settlement.description);
          const dateDistanceDays = Number(settlement.date_distance_days);
          const dateMatch = Number.isFinite(dateDistanceDays) && dateDistanceDays <= 1;
          const exactDateMatch = dateDistanceDays === 0;
          candidates.push({
            candidateType: "qris_settlement",
            candidateId: Number(settlement.id),
            score: exactDateMatch ? 100 : 95,
            amountMatch: true,
            dateMatch,
            referenceMatch,
            nameMatch,
            reason: exactDateMatch
              ? "Nominal net dan tanggal settlement QRIS canonical cocok."
              : "Nominal net QRIS canonical cocok; tanggal settlement dalam toleransi 1 hari.",
          });
        }
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "42P01" && code !== "42703") throw error;
      }
    }

    try {
      const sportPayments = await client.query<{
        id: number;
        amount: string;
        paid_date: string | null;
        payment_reference: string | null;
        description: string | null;
        customer_name: string | null;
        order_ref: string | null;
      }>(
        `with eligible as (
           select sp.*,
                  sb.customer_name as booking_customer_name,
                  sb.order_number as booking_order_number,
                  nullif(btrim(sb.group_ref::text), '') as normalized_group_id,
                  lower(coalesce(
                    to_jsonb(sp)->>'payment_method',
                    to_jsonb(sp)->>'method',
                    sp.payment_type::text,
                    ''
                  )) as normalized_method
             from sport_center.sport_payments sp
             left join sport_center.sport_bookings sb on sb.id = sp.booking_id
            where coalesce(sp.company_id, 1) = $1
              and lower(coalesce(sp.status::text, '')) in
                  ('confirmed', 'paid', 'completed', 'success', 'settled')
              and (
                (
                  not lower(coalesce(to_jsonb(sp)->>'payment_method', to_jsonb(sp)->>'method', sp.payment_type::text, '')) like '%qris%'
                  and (coalesce(sp.paid_at, sp.created_at) at time zone 'Asia/Jakarta')::date = $3::date
                )
                or (
                  lower(coalesce(to_jsonb(sp)->>'payment_method', to_jsonb(sp)->>'method', sp.payment_type::text, '')) like '%qris%'
                  and coalesce(
                    nullif(to_jsonb(sp)->>'expected_settlement_date','')::date,
                    ((coalesce(sp.paid_at, sp.created_at) at time zone 'Asia/Jakarta')::date + 1)
                  ) = $3::date
                )
              )
         ),
         grouped as (
           select
             min(sp.id)::bigint as id,
             sum(sp.amount::numeric) as amount,
             min((coalesce(sp.paid_at, sp.created_at) at time zone 'Asia/Jakarta')::date)::text as paid_date,
             coalesce(
               max(nullif(btrim(sp.provider_order_id::text), '')),
               max(sp.provider_id::text)
             ) as payment_reference,
             concat_ws(
               ' ',
               max(sp.booking_customer_name),
               max(sp.booking_order_number),
               max(sp.payment_type::text),
               max(sp.payment_provider::text),
               max(sp.provider_order_id::text),
               'group',
               sp.normalized_group_id
             ) as description,
             max(sp.booking_customer_name) as customer_name,
             max(sp.booking_order_number) as order_ref,
             bool_or(sp.normalized_method like '%qris%') as is_qris,
             min(coalesce(
               nullif(to_jsonb(sp)->>'expected_settlement_date','')::date,
               ((coalesce(sp.paid_at, sp.created_at) at time zone 'Asia/Jakarta')::date + 1)
             )) as settlement_date
           from eligible sp
          where sp.normalized_group_id is not null
          group by sp.normalized_group_id
         ),
         singles as (
           select
             sp.id::bigint as id,
             sp.amount::numeric as amount,
             (coalesce(sp.paid_at, sp.created_at) at time zone 'Asia/Jakarta')::date::text as paid_date,
             coalesce(sp.provider_order_id, sp.provider_id::text) as payment_reference,
             concat_ws(
               ' ',
               sp.booking_customer_name,
               sp.booking_order_number,
               sp.payment_type,
               sp.payment_provider,
               sp.provider_order_id
             ) as description,
             sp.booking_customer_name as customer_name,
             sp.booking_order_number as order_ref,
             (sp.normalized_method like '%qris%') as is_qris,
             coalesce(
               nullif(to_jsonb(sp)->>'expected_settlement_date','')::date,
               ((coalesce(sp.paid_at, sp.created_at) at time zone 'Asia/Jakarta')::date + 1)
             ) as settlement_date
           from eligible sp
          where sp.normalized_group_id is null
         ),
         candidates as (
           -- Grouped booking payments are represented by the canonical
           -- sport_group_payment candidate below. sport_payments may contain
           -- one mirrored row per booking, so SUM(sp.amount) is not bank truth.
           select * from singles
         )
         select c.id, c.amount, c.paid_date, c.payment_reference, c.description,
                c.customer_name, c.order_ref
           from candidates c
          where abs(c.amount::numeric - $2::numeric) < 0.01
            and (
              (not c.is_qris and c.paid_date::date = $3::date)
              or
              (c.is_qris and c.settlement_date = $3::date)
            )
            and not exists (
              select 1
                from public.bank_reconciliation_matches brm
               where brm.candidate_type = 'sport_payment'
                 and brm.candidate_id = c.id
                 and brm.candidate_source = 'sport_center.sport_payments'
                 and brm.status in ('approved', 'posted')
            )
          order by c.id`,
        [mutation.company_id, amount, date],
      );

      for (const payment of sportPayments.rows) {
        const referenceMatch =
          Boolean(mutation.provider_order_id) &&
          normalizeMatchText(mutation.provider_order_id) === normalizeMatchText(payment.payment_reference);
        const nameMatch = tokenOverlap(mutation.description, payment.description);
        const dateMatch = payment.paid_date === date;
        const score = 60 + (dateMatch ? 25 : 0) + (referenceMatch ? 15 : nameMatch ? 8 : 0);
        candidates.push({
          candidateType: "sport_payment",
          candidateId: payment.id,
          score,
          amountMatch: true,
          dateMatch,
          referenceMatch,
          nameMatch,
          reason: referenceMatch
            ? "Nominal, tanggal, dan referensi payment cocok."
            : nameMatch
              ? "Nominal, tanggal, dan nama customer cocok."
              : dateMatch
                ? "Nominal dan tanggal payment cocok."
                : "Nominal dan tanggal settlement cocok.",
          customerName: payment.customer_name,
          orderRef: payment.order_ref,
        });
      }
    } catch (error) {
      // Sport Center is an optional source on installations that only use
      // bank imports and vendor invoices. Keep matching usable when that
      // optional schema is not installed.
      const code = (error as { code?: string }).code;
      if (code !== "42P01" && code !== "42703") throw error;
    }

    try {
      const sportGroupPayments = await client.query<{
        id: number;
        amount: string;
        group_total: string;
        deposit_created: string;
        deposit_applied: string;
        paid_date: string | null;
        payment_reference: string | null;
        description: string | null;
        customer_name: string | null;
        order_ref: string | null;
      }>(
        `select
             bg.id::bigint as id,
             (
               coalesce(bg.total_payment_override, bg.net_payment, bg.total_payment)::numeric
               + coalesce((
                   select sum(cda.amount)
                     from sport_center.customer_deposit_allocations cda
                    where cda.company_id = $1
                      and cda.source_group_ref = bg.group_ref
                      and cda.status in ('available','reserved','applied')
                 ), 0)
               - coalesce((
                   select sum(cda.amount)
                     from sport_center.customer_deposit_allocations cda
                    where cda.company_id = $1
                      and cda.target_group_ref = bg.group_ref
                      and cda.status in ('reserved','applied')
                 ), 0)
             )::numeric as amount,
             coalesce(bg.total_payment_override, bg.net_payment, bg.total_payment)::numeric as group_total,
             coalesce((
               select sum(cda.amount)
                 from sport_center.customer_deposit_allocations cda
                where cda.company_id = $1
                  and cda.source_group_ref = bg.group_ref
                  and cda.status in ('available','reserved','applied')
             ), 0)::numeric as deposit_created,
             coalesce((
               select sum(cda.amount)
                 from sport_center.customer_deposit_allocations cda
                where cda.company_id = $1
                  and cda.target_group_ref = bg.group_ref
                  and cda.status in ('reserved','applied')
             ), 0)::numeric as deposit_applied,
             $3::date::text as paid_date,
             bg.group_ref as payment_reference,
             concat_ws(
               ' ',
               bg.customer_name,
               bg.group_ref,
               'sport center group',
               min(sb.booking_date)::text,
               max(sb.booking_date)::text
             ) as description,
             bg.customer_name,
             bg.group_ref as order_ref
           from sport_center.booking_groups bg
           join sport_center.sport_bookings sb
             on nullif(btrim(sb.group_ref::text), '') = bg.group_ref
          where exists (
                  select 1
                    from sport_center.facility_company_mappings fcm
                   where fcm.facility_id = sb.facility_id
                     and fcm.company_id = $1
                     and fcm.is_active = true
                     and fcm.approval_status = 'OWNER_APPROVED'
                )
            and exists (
                  select 1
                    from sport_center.sport_payments sp
                    join sport_center.sport_bookings paid_booking
                      on paid_booking.id = sp.booking_id
                   where nullif(btrim(paid_booking.group_ref::text), '') = bg.group_ref
                     and lower(coalesce(sp.status::text, '')) in
                         ('confirmed','paid','completed','success','settled')
                     and lower(coalesce(sp.payment_method::text, '')) not like '%qris%'
                     and (coalesce(sp.paid_at, sp.created_at) at time zone 'Asia/Jakarta')::date = $3::date
                )
          group by bg.id, bg.group_ref, bg.customer_name, bg.total_payment_override, bg.net_payment, bg.total_payment
         having abs((
                   coalesce(bg.total_payment_override, bg.net_payment, bg.total_payment)::numeric
                   + coalesce((
                       select sum(cda.amount)
                         from sport_center.customer_deposit_allocations cda
                        where cda.company_id = $1
                          and cda.source_group_ref = bg.group_ref
                          and cda.status in ('available','reserved','applied')
                     ), 0)
                   - coalesce((
                       select sum(cda.amount)
                         from sport_center.customer_deposit_allocations cda
                        where cda.company_id = $1
                          and cda.target_group_ref = bg.group_ref
                          and cda.status in ('reserved','applied')
                     ), 0)
                 ) - $2::numeric) < 0.01
            and not exists (
                  select 1
                    from public.bank_reconciliation_matches brm
                   where brm.candidate_type = 'sport_group_payment'
                     and brm.candidate_id = bg.id
                     and brm.candidate_source = 'sport_center.booking_groups'
                     and brm.status in ('approved','posted')
                )
          order by bg.id`,
        [mutation.company_id, amount, date],
      );

      for (const group of sportGroupPayments.rows) {
        const referenceMatch =
          Boolean(mutation.provider_order_id) &&
          normalizeMatchText(mutation.provider_order_id) === normalizeMatchText(group.payment_reference);
        const nameMatch = tokenOverlap(mutation.description, group.description);
        const dateMatch = group.paid_date === date;
        const depositCreated = Number(group.deposit_created ?? 0);
        const depositApplied = Number(group.deposit_applied ?? 0);
        candidates.push({
          candidateType: "sport_group_payment",
          candidateId: Number(group.id),
          score: Math.min(100, 85 + (referenceMatch ? 10 : nameMatch ? 5 : 0)),
          amountMatch: true,
          dateMatch,
          referenceMatch,
          nameMatch,
          reason: depositApplied > 0
            ? `Nominal bank cocok dengan group setelah DP lama Rp ${depositApplied.toLocaleString("id-ID")} digunakan.`
            : depositCreated > 0
              ? `Nominal bank cocok dengan tagihan group + DP baru Rp ${depositCreated.toLocaleString("id-ID")}.`
              : "Nominal dan tanggal pembayaran group Sport Center cocok.",
          customerName: group.customer_name,
          orderRef: group.order_ref,
        });

[executed on device: srv1792369 (0891e23a-6a6b-4f8c-a16a-962e888e2014)]