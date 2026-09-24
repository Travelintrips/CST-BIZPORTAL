import { Router, type IRouter, type Request } from "express";
import { pool } from "@workspace/db";
import { evaluateReconRules, type ReconRule } from "../lib/reconciliation/reconRuleEngine";
import { hydrateQrisReviewDiagnostics } from "../lib/reconciliation/qrisReviewDiagnostics";
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
  bank_account_number: string | null;
  bank_name: string | null;
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

interface LocalMatchCandidate {
  candidateType: "sport_payment" | "sport_company_invoice" | "tenant_invoice" | "vendor_invoice" | "qris_settlement";
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
    case "sport_company_invoice":
      return "sport_center.company_invoices";
    case "tenant_invoice":
      return "public.tenant_payments";
    case "vendor_invoice":
      return "public.vendor_invoices";
    case "qris_settlement":
      return "sport_center.payment_settlement_batches";
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
  const allowedRoles = new Set(["admin", "owner", "finance", "accounting"]);

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

  if (direction === "IN") {
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
           select * from grouped
           union all
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
      const sportCompanyInvoices = await client.query<{
        id: number;
        amount: string;
        paid_date: string | null;
        payment_reference: string | null;
        description: string | null;
      }>(
        `select
             ci.id,
             coalesce(
               nullif(ci.net_amount::numeric, 0),
               nullif(ci.paid_amount::numeric, 0),
               ci.grand_total::numeric
             ) as amount,
             (ci.paid_at at time zone 'Asia/Jakarta')::date::text as paid_date,
             ci.invoice_number as payment_reference,
             concat_ws(
               ' ',
               customer.name,
               ci.invoice_number,
               (
                 select string_agg(distinct nullif(btrim(sb.group_ref::text), ''), ' ')
                   from sport_center.company_invoice_items cii2
                   join sport_center.sport_bookings sb on sb.id = cii2.booking_id
                  where cii2.invoice_id = ci.id
               )
             ) as description
          from sport_center.company_invoices ci
          left join sport_center.users customer on customer.id = ci.company_customer_id
         where lower(coalesce(nullif(ci.invoice_status, ''), nullif(ci.status, ''), '')) in
               ('paid', 'confirmed', 'completed', 'success', 'settled')
           and ci.paid_at is not null
           and abs(
             coalesce(
               nullif(ci.net_amount::numeric, 0),
               nullif(ci.paid_amount::numeric, 0),
               ci.grand_total::numeric
             ) - $2::numeric
           ) < 0.01
           and (ci.paid_at at time zone 'Asia/Jakarta')::date = $3::date
           and exists (
             select 1
               from sport_center.company_invoice_items cii
               join sport_center.sport_bookings sb on sb.id = cii.booking_id
               join sport_center.facility_company_mappings fcm
                 on fcm.facility_id = sb.facility_id
                and fcm.company_id = $1
                and fcm.is_active = true
                and fcm.approval_status = 'OWNER_APPROVED'
              where cii.invoice_id = ci.id
           )
           and not exists (
             select 1
               from sport_center.company_invoice_items cii3
               join sport_center.sport_payments sp3 on sp3.booking_id = cii3.booking_id
              where cii3.invoice_id = ci.id
                and lower(coalesce(sp3.status::text, '')) in
                    ('confirmed', 'paid', 'completed', 'success', 'settled')
                and abs(sp3.amount::numeric - coalesce(
                  nullif(ci.net_amount::numeric, 0),
                  nullif(ci.paid_amount::numeric, 0),
                  ci.grand_total::numeric
                )) < 0.01
                and (coalesce(sp3.paid_at, sp3.created_at) at time zone 'Asia/Jakarta')::date =
                    (ci.paid_at at time zone 'Asia/Jakarta')::date
           )
           and not exists (
             select 1
               from public.bank_reconciliation_matches brm
              where brm.candidate_type = 'sport_company_invoice'
                and brm.candidate_id = ci.id
                and brm.candidate_source = 'sport_center.company_invoices'
                and brm.status in ('approved', 'posted')
           )
         order by ci.id`,
        [mutation.company_id, amount, date],
      );

      for (const invoice of sportCompanyInvoices.rows) {
        const referenceMatch =
          Boolean(mutation.provider_order_id) &&
          normalizeMatchText(mutation.provider_order_id) === normalizeMatchText(invoice.payment_reference);
        const nameMatch = tokenOverlap(mutation.description, invoice.description);
        const dateMatch = invoice.paid_date === date;
        const score = 60 + (dateMatch ? 25 : 0) + (referenceMatch ? 15 : nameMatch ? 8 : 0);
        candidates.push({
          candidateType: "sport_company_invoice",
          candidateId: invoice.id,
          score,
          amountMatch: true,
          dateMatch,
          referenceMatch,
          nameMatch,
          reason: referenceMatch
            ? "Nominal, tanggal, dan referensi invoice perusahaan Sport Center cocok."
            : dateMatch
              ? "Nominal dan tanggal pembayaran invoice perusahaan Sport Center cocok."
              : "Nominal invoice perusahaan Sport Center cocok; konfirmasi pembayaran sebelum approve.",
        });
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "42P01" && code !== "42703") throw error;
    }

    try {
      const tenantPayments = await client.query<{
        id: number;
        amount: string;
        paid_date: string | null;
        payment_reference: string | null;
        description: string | null;
      }>(
        `select tp.id,
                tp.amount,
                coalesce(
                  (tp.paid_at at time zone 'Asia/Jakarta')::date,
                  (tp.created_at at time zone 'Asia/Jakarta')::date
                )::text as paid_date,
                tp.payment_number as payment_reference,
                concat_ws(
                  ' ',
                  t.business_name,
                  tb.order_number,
                  tp.payment_number,
                  tp.method
                ) as description
           from public.tenant_payments tp
           left join public.tenant_bookings tb on tb.id = tp.tenant_booking_id
           left join public.tenants t on t.id = coalesce(tp.tenant_id, tb.tenant_id)
          where tp.company_id = $1
            and lower(coalesce(tp.status::text, '')) in ('confirmed', 'paid', 'approved', 'completed', 'success', 'settled')
            and nullif(to_jsonb(tp)->>'duplicate_of_payment_id', '') is null
            and lower(coalesce(tp.method::text, '')) not like '%qris%'
            and abs(tp.amount::numeric - $2::numeric) < 0.01
            and coalesce(
                  (tp.paid_at at time zone 'Asia/Jakarta')::date,
                  (tp.created_at at time zone 'Asia/Jakarta')::date
                ) = $3::date
            and not exists (
              select 1
                from public.bank_reconciliation_matches brm
               where brm.candidate_type = 'tenant_invoice'
                 and brm.candidate_id = tp.id
                 and brm.candidate_source = 'public.tenant_payments'
                 and brm.status in ('approved', 'posted')
            )
          order by tp.id`,
        [mutation.company_id, amount, date],
      );

      for (const payment of tenantPayments.rows) {
        const referenceMatch =
          Boolean(mutation.provider_order_id) &&
          normalizeMatchText(mutation.provider_order_id) === normalizeMatchText(payment.payment_reference);
        const nameMatch = tokenOverlap(mutation.description, payment.description);
        const dateMatch = payment.paid_date === date;
        const score = 60 + (dateMatch ? 25 : 0) + (referenceMatch ? 15 : nameMatch ? 8 : 0);
        candidates.push({
          candidateType: "tenant_invoice",
          candidateId: payment.id,
          score,
          amountMatch: true,
          dateMatch,
          referenceMatch,
          nameMatch,
          reason: referenceMatch
            ? "Nominal, tanggal, dan referensi pembayaran tenant cocok."
            : dateMatch
              ? "Nominal dan tanggal pembayaran tenant cocok."
              : "Nominal pembayaran tenant cocok; konfirmasi tenant sebelum approve.",
        });
      }
    } catch (error) {
      // Tenant is optional on installations that only use Sport Center and
      // vendor invoices.
      const code = (error as { code?: string }).code;
      if (code !== "42P01" && code !== "42703") throw error;
    }
  } else if (direction === "OUT") {
    try {
      const invoices = await client.query<{
        id: number;
        invoice_number: string;
        vendor_invoice_ref: string | null;
        supplier_name: string;
        grand_total: string;
        due_date: string | null;
      }>(
        `with canonical_invoice_payments as (
           select pa.invoice_id,
                  sum(coalesce(pa.allocated_amount, 0))::numeric as canonical_paid
             from public.payment_allocations pa
             join public.payment_matching_groups pmg on pmg.id = pa.group_id
             join public.bank_mutations paid_bm
               on paid_bm.id = pa.mutation_id
              and paid_bm.company_id = pa.company_id
            where pa.company_id = $1
              and pa.mutation_id is not null
              and coalesce(pa.is_active, true) = true
              and (
                lower(coalesce(pmg.status, '')) in ('final', 'posted', 'reconciled')
                or lower(coalesce(paid_bm.status, '')) in ('final', 'posted', 'reconciled')
              )
            group by pa.invoice_id
         )
         select vi.id,
                vi.invoice_number,
                vi.vendor_invoice_ref,
                vi.supplier_name,
                vi.grand_total,
                vi.due_date
           from public.vendor_invoices vi
           left join canonical_invoice_payments cip on cip.invoice_id = vi.id
          where vi.company_id = $1
            and vi.status::text = 'posted'
            and abs(greatest(vi.grand_total::numeric - coalesce(cip.canonical_paid, 0), 0) - $2::numeric) < 0.01
            and not exists (
              select 1
                from public.bank_reconciliation_matches brm
               where brm.candidate_type = 'vendor_invoice'
                 and brm.candidate_id = vi.id
                 and brm.candidate_source = 'public.vendor_invoices'
                 and brm.status in ('approved', 'posted')
            )
          order by vi.due_date nulls last, vi.id
          limit 50`,
        [mutation.company_id, amount],
      );

      for (const invoice of invoices.rows) {
        const referenceMatch = tokenOverlap(
          mutation.provider_order_id,
          `${invoice.invoice_number} ${invoice.vendor_invoice_ref ?? ""}`,
        );
        const nameMatch = tokenOverlap(mutation.description, invoice.supplier_name);
        const dateMatch = invoice.due_date === date;
        const score = 60 + (referenceMatch ? 25 : 0) + (nameMatch ? 15 : 0);
        candidates.push({
          candidateType: "vendor_invoice",
          candidateId: invoice.id,
          score,
          amountMatch: true,
          dateMatch,
          referenceMatch,
          nameMatch,
          reason: referenceMatch || nameMatch
            ? "Nominal dan identitas invoice/supplier cocok."
            : "Nominal invoice cocok; konfirmasi supplier sebelum approve.",
        });
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "42P01" && code !== "42703") throw error;
    }
  }

  return candidates.sort((left, right) => right.score - left.score || left.candidateId - right.candidateId);
}

async function loadActiveRuleAi(client: ApprovalClient, companyId: number): Promise<ReconRule[]> {
  const result = await client.query<any>("select * from public.recon_rules where company_id=$1 and is_active=true order by priority desc, specificity desc nulls last, confidence_score desc, id", [companyId]);
  return result.rows.map((r:any)=>({id:Number(r.id),companyId:Number(r.company_id),name:String(r.name),description:r.description??null,priority:Number(r.priority??0),isActive:Boolean(r.is_active),direction:r.direction==='IN'||r.direction==='OUT'?r.direction:null,bankAccountId:r.bank_account_id==null?null:Number(r.bank_account_id),conditionType:String(r.condition_type??'single'),conditionField:r.condition_field,conditionOperator:r.condition_operator,conditionValue:String(r.condition_value??''),conditionsJson:Array.isArray(r.conditions_json)?r.conditions_json:null,logic:String(r.logic??'AND').toUpperCase()==='OR'?'OR':'AND',specificity:Number(r.specificity??1),amountTolerance:r.amount_tolerance==null?null:Number(r.amount_tolerance),referenceAmount:r.reference_amount==null?null:Number(r.reference_amount),candidateRequirement:r.candidate_requirement==='not_required'?'not_required':'required',requiresDocumentUpload:Boolean(r.requires_document_upload),taxType:r.tax_type==='ppn_input'||r.tax_type==='ppn_output'?r.tax_type:'none',aiClassificationRuleId:r.ai_classification_rule_id==null?null:Number(r.ai_classification_rule_id),targetType:r.target_type,targetId:r.target_id==null?null:Number(r.target_id),targetCoaCode:r.target_coa_code??null,confidenceScore:Number(r.confidence_score??100),stopProcessing:Boolean(r.stop_processing),matchCount:Number(r.match_count??0),lastMatchedAt:r.last_matched_at??null,createdBy:r.created_by??null,createdAt:String(r.created_at??''),updatedAt:String(r.updated_at??'')})) as ReconRule[];
}

async function matchLocalMutation(
  client: ApprovalClient,
  mutation: MatchingMutation,
  actor: ApprovalActor,
): Promise<"matched" | "auto_posted" | "manual_review" | "unmatched"> {
  if (mutation.company_id == null) return "unmatched";

  await client.query(
    `delete from public.bank_reconciliation_matches
      where mutation_id = $1
        and status not in ('approved', 'posted')`,
    [mutation.id],
  );

  // A previous historical cleanup may have removed an old reconciliation
  // journal while leaving audit rows behind. Audit history is evidence only;
  // it must never be rehydrated as a live matching candidate.
  const candidates = (await loadLocalMatchCandidates(client, mutation)).filter(
    (candidate) => candidate.candidateType !== ("recon_rule" as LocalMatchCandidate["candidateType"]),
  );
  const rules = await loadActiveRuleAi(client, mutation.company_id);
  const ruleResult = evaluateReconRules(rules,{description:mutation.description??'',reference:mutation.bank_reference??mutation.provider_order_id??null,amount:Number(mutation.amount),direction:String(mutation.direction).toUpperCase() as 'IN'|'OUT',bankAccountId:mutation.bank_account_id&&/^\\d+$/.test(mutation.bank_account_id)?Number(mutation.bank_account_id):null,bank:mutation.provider_name??null,normalizedDescription:mutation.normalized_description??null,hasDocumentUpload:Boolean(mutation.uploaded_proof_url),companyId:mutation.company_id});
  if(ruleResult.documentRequired){await client.query("update public.bank_mutations set status='manual_review',reconciliation_status='manual_review',review_reason=$1,review_code='RULE_DOCUMENT_REQUIRED',updated_at=now() where id=$2 and status not in ('approved_pending_posting','approved','posted','void')",['Rule '+ruleResult.documentRequired.ruleName+' mewajibkan dokumen.',mutation.id]);return 'manual_review';}
  if (ruleResult.matched && ruleResult.ruleId != null) {
    const matchedRule = rules.find((r) => r.id === ruleResult.ruleId)!;
    const realCandidate = candidates[0];
    const competitiveRealCandidates = realCandidate
      ? candidates.filter((candidate) => candidate.score >= realCandidate.score - 5)
      : [];
    const ambiguousRequiredCandidates =
      matchedRule.candidateRequirement === "required" &&
      competitiveRealCandidates.length > 1;

    if (!realCandidate && matchedRule.candidateRequirement !== "not_required") {
      await client.query(
        "update public.bank_mutations set status='unmatched',reconciliation_status='unmatched',review_reason='Rule AI cocok tetapi belum ada kandidat transaksi canonical. Mutasi tetap Belum Dicocokkan sampai kandidat tersedia.',review_code='RULE_NO_CANONICAL_CANDIDATE',updated_at=now() where id=$1 and status not in ('approved_pending_posting','approved','posted','void')",
        [mutation.id],
      );
      await client.query(
        "insert into public.bank_reconciliation_audit (mutation_id,action,actor,meta) values ($1,'RULE_NO_CANONICAL_CANDIDATE_UNMATCHED',$2,$3::jsonb)",
        [
          mutation.id,
          actor.email,
          JSON.stringify({
            rule_id: ruleResult.ruleId,
            rule_name: matchedRule.name,
            candidate_requirement: matchedRule.candidateRequirement,
          }),
        ],
      );
      return "unmatched";
    }

    await client.query(
      "insert into public.bank_reconciliation_matches (mutation_id,candidate_type,candidate_id,match_score,match_reason,amount_match,date_match,name_match,order_id_match,proof_match,status,candidate_source) values ($1,'recon_rule',$2,$3,$4,true,false,true,false,$5,'candidate','public.recon_rules')",
      [
        mutation.id,
        ruleResult.ruleId,
        Math.round(ruleResult.confidence ?? matchedRule.confidenceScore),
        "RULE_AI:" + matchedRule.name,
        Boolean(mutation.uploaded_proof_url),
      ],
    );

    for (const candidate of competitiveRealCandidates) {
      await client.query(
        `insert into public.bank_reconciliation_matches
          (mutation_id, candidate_type, candidate_id, match_score, match_reason,
           amount_match, date_match, name_match, order_id_match, proof_match,
           status, candidate_source, customer_name, order_ref)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,'candidate',$10,$11,$12)`,
        [
          mutation.id,
          candidate.candidateType,
          candidate.candidateId,
          Math.round(candidate.score),
          candidate.reason,
          candidate.amountMatch,
          candidate.dateMatch,
          candidate.nameMatch,
          candidate.referenceMatch,
          localCandidateSource(candidate.candidateType),
          candidate.customerName ?? null,
          candidate.orderRef ?? null,
        ],
      );
    }

    if (ambiguousRequiredCandidates) {
      await client.query(
        "update public.bank_mutations set status='manual_review',reconciliation_status='manual_review',review_reason='Rule AI cocok dan menemukan lebih dari satu kandidat canonical dengan skor setara. Pilih transaksi yang benar sebelum approve.',review_code='RULE_MULTIPLE_CANONICAL_CANDIDATES',updated_at=now() where id=$1 and status not in ('approved_pending_posting','approved','posted','void')",
        [mutation.id],
      );
      await client.query(
        "insert into public.bank_reconciliation_audit (mutation_id,action,actor,meta) values ($1,'MATCH_CREATED',$2,$3::jsonb)",
        [
          mutation.id,
          actor.email,
          JSON.stringify({
            engine: "bizportal-rule-ai",
            rule_id: ruleResult.ruleId,
            rule_name: matchedRule.name,
            confidence: ruleResult.confidence ?? matchedRule.confidenceScore,
            candidate_requirement: matchedRule.candidateRequirement,
            real_candidate_ids: competitiveRealCandidates.map((candidate) => candidate.candidateId),
            ambiguity: true,
          }),
        ],
      );
      return "manual_review";
    }

    await client.query(
      "update public.bank_mutations set status='matched',reconciliation_status='matched',review_reason=$1,review_code='RULE_AI_MATCH',updated_at=now() where id=$2 and status not in ('approved_pending_posting','approved','posted','void')",
      ["Rule AI: " + matchedRule.name, mutation.id],
    );
    await client.query(
      "update public.recon_rules set match_count=coalesce(match_count,0)+1,last_matched_at=now() where id=$1",
      [ruleResult.ruleId],
    );
    await client.query(
      "insert into public.bank_reconciliation_audit (mutation_id,action,actor,meta) values ($1,'MATCH_CREATED',$2,$3::jsonb)",
      [
        mutation.id,
        actor.email,
        JSON.stringify({
          engine: "bizportal-rule-ai",
          rule_id: ruleResult.ruleId,
          rule_name: matchedRule.name,
          confidence: ruleResult.confidence ?? matchedRule.confidenceScore,
          candidate_requirement: matchedRule.candidateRequirement,
          real_candidate_id: realCandidate?.candidateId ?? null,
        }),
      ],
    );

    const confidence = Number(ruleResult.confidence ?? matchedRule.confidenceScore);
    const autoPostEligible = confidence === 100
      && matchedRule.candidateRequirement !== 'required'
      && !realCandidate
      && !matchedRule.requiresDocumentUpload
      && Boolean(matchedRule.targetCoaCode)
      && !ruleResult.ambiguityCode
      && !hasQrisBankEvidenceForAutoPost(mutation);
    if (autoPostEligible) {
      const ruleMatch = await client.query<{ id: number }>(
        "select id from public.bank_reconciliation_matches where mutation_id=$1 and candidate_type='recon_rule' and candidate_id=$2 and status='candidate' order by id desc limit 1 for update",
        [mutation.id, ruleResult.ruleId],
      );
      const matchId = ruleMatch.rows[0]?.id;
      if (matchId != null) {
        const approval = await approveBankMutation(
          client,
          mutation.id,
          {
            match_id: matchId,
            candidate_type: 'recon_rule',
            candidate_id: ruleResult.ruleId,
            candidate_source: 'public.recon_rules',
            manual_coa_code: matchedRule.targetCoaCode,
            note: "Auto-approved by Rule AI 100%",
          },
          actor,
          `rule-ai:${mutation.id}:${ruleResult.ruleId}`,
        );
        const entryId = safeInteger(approval.journal_entry_id);
        if (entryId == null) {
          throw new ApprovalError(
            "Rule AI approval tidak menghasilkan jurnal.",
            409,
            "AUTO_POST_JOURNAL_MISSING",
          );
        }
        await postBankMutationCanonical(client, mutation.id, entryId, matchId, actor, {
          engine: "bizportal-rule-ai",
          rule_id: ruleResult.ruleId,
          rule_name: matchedRule.name,
          confidence,
          coa_code: matchedRule.targetCoaCode,
          reason: "Rule AI 100% auto-approved dan auto-posted: " + matchedRule.name,
          review_code: 'RULE_AI_AUTO_POSTED',
        });
        return "auto_posted";
      }
    }
    return "matched";
  }
  const best = candidates[0];
  const competitiveCandidates = best
    ? candidates.filter((candidate) => candidate.score >= best.score - 5)
    : [];
  const isAmbiguous = competitiveCandidates.length > 1;
  const nextStatus = !best
    ? "unmatched"
    : isAmbiguous
      ? "manual_review"
      : best.score >= 80
        ? "matched"
        : "manual_review";

  for (const candidate of competitiveCandidates) {
    await client.query(
      `insert into public.bank_reconciliation_matches
        (mutation_id, candidate_type, candidate_id, match_score, match_reason,
         amount_match, date_match, name_match, order_id_match, proof_match,
         status, candidate_source, customer_name, order_ref)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, 'candidate', $10, $11, $12)`,
      [
        mutation.id,
        candidate.candidateType,
        candidate.candidateId,
        Math.round(candidate.score),
        candidate.reason,
        candidate.amountMatch,
        candidate.dateMatch,
        candidate.nameMatch,
        candidate.referenceMatch,
        localCandidateSource(candidate.candidateType),
        candidate.customerName ?? null,
        candidate.orderRef ?? null,
      ],
    );
  }

  await client.query(
    `update public.bank_mutations
        set status = $1,
            reconciliation_status = $2,
            review_reason = $3,
            review_code = $4,
            updated_at = now()
      where id = $5
        and status not in ('approved_pending_posting', 'approved', 'posted', 'void')`,
    [
      nextStatus,
      nextStatus,
      best
        ? (isAmbiguous
            ? "Lebih dari satu kandidat memiliki kecocokan serupa. Pilih transaksi yang benar sebelum approve."
            : best.reason)
        : null,
      best ? (isAmbiguous ? "MULTIPLE_CANDIDATES" : "LOCAL_MATCHING") : null,
      mutation.id,
    ],
  );

  await client.query(
    `insert into public.bank_reconciliation_audit
      (mutation_id, action, actor, meta)
     values ($1, 'MATCH_CREATED', $2, $3::jsonb)`,
    [
      mutation.id,
      actor.email,
      JSON.stringify({
        engine: "bizportal-local-matching",
        candidate_count: candidates.length,
        persisted_candidate_count: competitiveCandidates.length,
        candidate_type: best?.candidateType ?? null,
        candidate_id: best?.candidateId ?? null,
        candidate_ids: competitiveCandidates.map((candidate) => candidate.candidateId),
        score: best?.score ?? null,
        status: nextStatus,
      }),
    ],
  );

  return nextStatus;

}

router.get("/bank-reconciliation/run-matching/status", async (req, res): Promise<void> => {
  const actor = await getApprovalActor(req).catch(() => null);
  if (!actor) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // The local matcher runs synchronously and returns its aggregate result in
  // the POST response. Keep the status contract for the existing UI polling
  // path so a synchronous run never gets stuck in "running".
  res.json({
    ok: true,
    running: false,
    status: "idle",
    total: 0,
    processed: 0,
    failed: 0,
    summary: {},
    error: null,
  });
});

router.post("/bank-reconciliation/run-matching", async (req, res): Promise<void> => {
  const actor = await getApprovalActor(req).catch(() => null);
  if (!actor) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const body = (req.body ?? {}) as {
    ids?: unknown;
    matching_mode?: unknown;
    legacy_reference_coa_retry?: unknown;
  };
  const matchingMode = (body.matching_mode ?? "new") as MatchingMode;
  if (!["new", "retry_unmatched", "rematch_non_final"].includes(matchingMode)) {
    res.status(400).json({
      error: "Mode matching tidak valid. Gunakan new, retry_unmatched, atau rematch_non_final.",
    });
    return;
  }

  const requestedIds = Array.isArray(body.ids)
    ? body.ids.map((id) => safeInteger(id))
    : [];
  if (Array.isArray(body.ids) && requestedIds.some((id) => id == null)) {
    res.status(400).json({ error: "Daftar ID mutasi tidak valid." });
    return;
  }
  const ids = requestedIds.filter((id): id is number => id != null);
  if (body.legacy_reference_coa_retry === true && ids.length === 0) {
    res.status(400).json({ error: "Pilih satu atau lebih mutasi untuk diproses ulang." });
    return;
  }

  const values: unknown[] = [];
  const filters: string[] = [];
  const addValue = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (ids.length > 0) {
    filters.push(`bm.id = any(${addValue(ids)}::bigint[])`);
  }
  if (actor.companyId != null) {
    filters.push(`bm.company_id = ${addValue(actor.companyId)}`);
  }

  if (matchingMode === "new") {
    filters.push(`
      bm.status in ('unmatched', 'matched', 'duplicate_need_review')
      and not exists (
        select 1 from public.bank_reconciliation_audit audit
         where audit.mutation_id = bm.id
           and audit.action = 'MATCH_CREATED'
      )`);
  } else if (matchingMode === "retry_unmatched") {
    filters.push(`
      bm.status = 'unmatched'
      and exists (
        select 1 from public.bank_reconciliation_audit audit
         where audit.mutation_id = bm.id
           and audit.action = 'MATCH_CREATED'
      )`);
  } else {
    filters.push("bm.status in ('unmatched', 'matched', 'manual_review', 'duplicate_need_review')");
    filters.push(`not exists (
      select 1 from public.bank_reconciliation_matches final_match
       where final_match.mutation_id = bm.id
         and final_match.status in ('approved', 'posted')
    )`);
  }

  const client = await pool.connect();
  try {
    const result = await client.query<MatchingMutation>(
      `select bm.id, bm.amount, bm.direction, bm.transaction_date::text as transaction_date,
              bm.description, bm.normalized_description, bm.provider_order_id,
              bm.company_id, bm.status, bm.bank_account_id, bm.bank_reference,
              bm.provider_name, bm.uploaded_proof_url, bm.review_code
         from public.bank_mutations bm
        where ${filters.join(" and ")}
        order by bm.transaction_date desc, bm.id
        limit 200`,
      values as any[],
    );

    let processed = 0;
    let autoMatched = 0;
    let manualReview = 0;
    let unmatched = 0;
    let failed = 0;
    let ruleMatched = 0;
    let autoPosted = 0;

    for (const mutation of result.rows) {
      try {
        await client.query("begin");
        const outcome = await matchLocalMutation(client, mutation, actor);
        await client.query("commit");
        processed++;
        if (outcome === "matched" || outcome === "auto_posted") autoMatched++;
        if (outcome === "auto_posted") autoPosted++;
        const marker = await client.query<{ review_code: string | null }>("select review_code from public.bank_mutations where id=$1", [mutation.id]);
        if (marker.rows[0]?.review_code === "RULE_AI_MATCH" || marker.rows[0]?.review_code === "RULE_AI_AUTO_POSTED") ruleMatched++;
        else if (outcome === "manual_review") manualReview++;
        else unmatched++;
      } catch (error) {
        failed++;
        try {
          await client.query("rollback");
        } catch (rollbackError) {
          req.log.warn({ rollbackError, mutationId: mutation.id }, "Matching rollback failed");
        }
        req.log.warn({ error, mutationId: mutation.id }, "Local bank matching failed for mutation");
      }
    }

    res.json({
      ok: true,
      queued: false,
      processed,
      failed,
      auto_matched: autoMatched,
      auto_posted: autoPosted,
      manual_review: manualReview,
      unmatched,
      rule_matched: ruleMatched,
      ecf_matched: 0,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "42P01" || code === "42703") {
      res.status(503).json({
        error: "Schema bank reconciliation atau sumber matching belum tersedia.",
        code: "BANK_RECONCILIATION_SCHEMA_UNAVAILABLE",
      });
      return;
    }
    req.log.error({ error }, "Local bank matching failed");
    res.status(503).json({ error: "AI Matching lokal gagal dijalankan." });
  } finally {
    client.release();
  }
});

type SourceReceiptJournal = {
  entryId: number;
  entryNumber: string;
  debitAccountId: number;
  debitAccountCode: string;
  debitAccountName: string;
  debitAmount: number;
};

function isSourceOwnedInboundCandidate(candidateType: string | null): boolean {
  const type = String(candidateType ?? "").toLowerCase();
  return type === "sport_payment" || type === "tenant_invoice";
}

async function resolvePostedSourceReceiptJournal(
  client: ApprovalClient,
  companyId: number,
  candidateType: string,
  candidateId: number,
  amount: number,
): Promise<SourceReceiptJournal> {
  const type = candidateType.toLowerCase();
  let sourceEntries: { rows: Array<{ id: number; entry_number: string; total_debit: string }> };

  if (type === "sport_payment") {
    sourceEntries = await client.query(
      `select ae.id, ae.entry_number, ae.total_debit::text
         from public.accounting_entries ae
        where ae.company_id = $1
          and ae.status = 'posted'
          and abs(ae.total_debit::numeric - $3::numeric) < 0.01
          and (
            ae.source_payment_id = $2
            or (
              ae.source::text in ('sport_center_payment','sport_center_booking','sport_center_membership')
              and ae.source_id = $2
            )
          )
        order by
          case when ae.source_payment_id = $2 then 0 else 1 end,
          ae.id desc
        limit 2`,
      [companyId, candidateId, amount],
    );
  } else if (type === "tenant_invoice") {
    sourceEntries = await client.query(
      `select ae.id, ae.entry_number, ae.total_debit::text
         from public.accounting_entries ae
        where ae.company_id = $1
          and ae.status = 'posted'
          and abs(ae.total_debit::numeric - $3::numeric) < 0.01
          and ae.source::text = 'tenant_rent_payment'
          and ae.source_id in (
            $2,
            coalesce(
              (
                select nullif(to_jsonb(tp)->>'duplicate_of_payment_id', '')::integer
                  from public.tenant_payments tp
                 where tp.id = $2
                   and tp.company_id = $1
                 limit 1
              ),
              $2
            )
          )
        order by
          case when ae.source_id = $2 then 0 else 1 end,
          ae.id desc
        limit 2`,
      [companyId, candidateId, amount],
    );
  } else {
    throw new ApprovalError(
      `Tipe kandidat "${candidateType}" tidak memiliki kontrak jurnal sumber.`,
      422,
      "SOURCE_JOURNAL_REQUIRED",
    );
  }

  if (sourceEntries.rows.length === 0) {
    throw new ApprovalError(
      type === "sport_payment"
        ? "Payment Sport Center belum memiliki jurnal sumber posted yang sesuai nominal. Rekonsiliasi diblokir agar tidak membuat pendapatan/piutang ganda."
        : "Pembayaran tenant belum memiliki jurnal sumber pendapatan posted yang sesuai nominal. Rekonsiliasi diblokir agar tidak membuat pendapatan/piutang ganda.",
      422,
      "SOURCE_JOURNAL_REQUIRED",
    );
  }
  if (sourceEntries.rows.length > 1) {
    throw new ApprovalError(
      "Lebih dari satu jurnal sumber posted cocok dengan transaksi ini. Periksa duplikasi jurnal sumber sebelum rekonsiliasi.",
      409,
      "SOURCE_JOURNAL_AMBIGUOUS",
    );
  }

  const sourceEntry = sourceEntries.rows[0]!;
  const debitLines = await client.query<{
    account_id: number;
    code: string;
    name: string;
    debit: string;
  }>(
    `select line.account_id, coa.code, coa.name, line.debit::text
       from public.accounting_entry_lines line
       join public.chart_of_accounts coa on coa.id = line.account_id
      where line.entry_id = $1
        and line.debit > 0
        and abs(line.debit::numeric - $2::numeric) < 0.01
        and (coa.company_id = $3 or coa.company_id is null)
        and coalesce(coa.is_active, true) = true
      order by
        case when coa.type::text = 'asset' then 0 else 1 end,
        line.id
      limit 2`,
    [sourceEntry.id, amount, companyId],
  );

  if (debitLines.rows.length === 0) {
    throw new ApprovalError(
      "Jurnal sumber ditemukan, tetapi akun debit penerimaan/clearing tidak dapat ditentukan secara aman.",
      422,
      "SOURCE_RECEIPT_ACCOUNT_UNRESOLVED",
    );
  }
  if (debitLines.rows.length > 1) {
    throw new ApprovalError(
      "Jurnal sumber memiliki lebih dari satu akun debit dengan nominal penuh. Rekonsiliasi perlu review manual.",
      409,
      "SOURCE_RECEIPT_ACCOUNT_AMBIGUOUS",
    );
  }

  const debitLine = debitLines.rows[0]!;
  return {
    entryId: sourceEntry.id,
    entryNumber: sourceEntry.entry_number,
    debitAccountId: debitLine.account_id,
    debitAccountCode: debitLine.code,
    debitAccountName: debitLine.name,
    debitAmount: Number(debitLine.debit),
  };
}

async function assertSportPaymentSourceReceiptAccount(
  client: ApprovalClient,
  companyId: number,
  candidateId: number,
  sourceJournal: SourceReceiptJournal,
): Promise<void> {
  const paymentResult = await client.query<{
    payment_method: string | null;
    payment_provider: string | null;
    bank_account_id: string | null;
  }>(
    `select payment_method::text, payment_provider::text, bank_account_id::text
       from sport_center.sport_payments
      where id = $1
        and coalesce(company_id, 1) = $2
      limit 1`,
    [candidateId, companyId],
  );
  const payment = paymentResult.rows[0];
  if (!payment) {
    throw new ApprovalError(
      "Payment Sport Center tidak ditemukan saat memvalidasi akun penerimaan sumber.",
      422,
      "SOURCE_JOURNAL_REQUIRED",
    );
  }

  const method = String(payment.payment_method ?? "").trim().toLowerCase();
  const provider = String(payment.payment_provider ?? "").trim().toLowerCase();
  const isDirectBankTransfer =
    method.includes("transfer")
    && (!provider || provider === "unknown" || provider === "manual");
  if (!isDirectBankTransfer) return;

  const externalBankAccountId = String(payment.bank_account_id ?? "").trim();
  if (!externalBankAccountId) {
    throw new ApprovalError(
      "Transfer Bank Sport Center tidak memiliki identitas rekening penerima canonical.",
      422,
      "SOURCE_PAYMENT_BANK_UNRESOLVED",
    );
  }

  const bankResult = await client.query<{ coa_id: number; code: string; name: string }>(
    `select cba.coa_id, coa.code, coa.name
       from public.company_bank_accounts cba
       join public.chart_of_accounts coa on coa.id = cba.coa_id
      where cba.company_id = $1
        and cba.account_number::text = $2
        and coalesce(cba.is_active, true) = true
        and coalesce(coa.is_active, true) = true
        and coalesce(coa.is_postable, true) = true
      order by cba.id
      limit 2`,
    [companyId, externalBankAccountId],
  );
  if (bankResult.rows.length !== 1) {
    throw new ApprovalError(
      `Rekening penerima Sport Center "${externalBankAccountId}" tidak memiliki tepat satu mapping COA aktif.`,
      422,
      "SOURCE_PAYMENT_BANK_UNRESOLVED",
    );
  }

  const expected = bankResult.rows[0]!;
  if (expected.coa_id !== sourceJournal.debitAccountId) {
    throw new ApprovalError(
      `Jurnal sumber Sport Center memakai ${sourceJournal.debitAccountCode} — ${sourceJournal.debitAccountName}, padahal payment Transfer Bank menunjuk ${expected.code} — ${expected.name}. Rekonsiliasi diblokir sampai jurnal sumber dikoreksi/reversal agar tidak membuat reklasifikasi palsu.`,
      409,
      "SOURCE_JOURNAL_BANK_MISMATCH",
    );
  }
}

async function assertSourceOwnedCandidateNotReconciledElsewhere(
  client: ApprovalClient,
  mutationId: number,
  candidateType: string,
  candidateId: number,
  candidateSource: string,
): Promise<void> {
  const existing = await client.query<{ mutation_id: number }>(
    `select mutation_id
       from public.bank_reconciliation_matches
      where candidate_type = $1
        and candidate_id = $2
        and candidate_source = $3
        and mutation_id <> $4
        and status in ('approved','posted')
      order by id desc
      limit 1`,
    [candidateType, candidateId, candidateSource, mutationId],
  );
  if (existing.rows[0]) {
    throw new ApprovalError(
      `Kandidat transaksi ini sudah direkonsiliasi oleh mutasi bank #${existing.rows[0].mutation_id}. Approval ganda diblokir.`,
      409,
      "SOURCE_CANDIDATE_ALREADY_RECONCILED",
    );
  }
}

async function finalizeSourceJournalReuse(
  client: ApprovalClient,
  mutationId: number,
  companyId: number,
  matchId: number | null,
  candidateType: string,
  candidateId: number,
  candidateSource: string,
  sourceJournal: SourceReceiptJournal,
  actor: ApprovalActor,
): Promise<Record<string, unknown>> {
  await client.query(
    `update public.bank_reconciliation_matches
        set status = 'superseded'
      where mutation_id = $1
        and ($2::bigint is null or id <> $2)
        and status not in ('approved','posted')`,
    [mutationId, matchId],
  );

  if (matchId != null) {
    await client.query(
      `update public.bank_reconciliation_matches
          set status = 'posted',
              candidate_source = coalesce(candidate_source, $3)
        where id = $1 and mutation_id = $2`,
      [matchId, mutationId, candidateSource],
    );
  } else {
    const promoted = await client.query(
      `update public.bank_reconciliation_matches
          set status = 'posted',
              candidate_source = coalesce(candidate_source, $4)
        where mutation_id = $1
          and candidate_type = $2
          and candidate_id = $3
          and (candidate_source = $4 or candidate_source is null)
          and status not in ('approved','posted')
        returning id`,
      [mutationId, candidateType, candidateId, candidateSource],
    );
    if (promoted.rowCount === 0) {
      await client.query(
        `insert into public.bank_reconciliation_matches
          (mutation_id,candidate_type,candidate_id,match_score,match_reason,
           amount_match,date_match,name_match,order_id_match,proof_match,status,candidate_source)
         values ($1,$2,$3,100,'source journal reuse',true,true,false,false,false,'posted',$4)`,
        [mutationId, candidateType, candidateId, candidateSource],
      );
    }
  }

  await client.query(
    `update public.bank_mutations
        set status = 'posted',
            reconciliation_status = 'reconciled',
            accounting_posted = true,
            journal_entry_id = $2,
            approved_by = $3,
            approved_at = coalesce(approved_at, now()),
            posted_at = coalesce(posted_at, now()),
            review_code = 'SOURCE_JOURNAL_REUSED',
            review_reason = 'Bank mutation linked to existing posted source journal; duplicate accounting entry suppressed',
            linked_transaction_type = $5,
            linked_transaction_id = $6,
            updated_at = now()
      where id = $1 and company_id = $4`,
    [mutationId, sourceJournal.entryId, actor.email, companyId, candidateType, candidateId],
  );

  await client.query(
    `insert into public.bank_reconciliation_audit(mutation_id,action,actor,meta)
     values($1,'SOURCE_JOURNAL_REUSED',$2,$3::jsonb)`,
    [
      mutationId,
      actor.email,
      JSON.stringify({
        candidate_type: candidateType,
        candidate_id: candidateId,
        candidate_source: candidateSource,
        source_journal_id: sourceJournal.entryId,
        source_journal_number: sourceJournal.entryNumber,
        receipt_account_id: sourceJournal.debitAccountId,
        receipt_account_code: sourceJournal.debitAccountCode,
        contract: "source-journal-reuse-v1",
      }),
    ],
  );

  return {
    ok: true,
    status: "posted",
    journal_entry_id: sourceJournal.entryId,
    journal_entry_number: sourceJournal.entryNumber,
    source_journal_reused: true,
    candidate_source: candidateSource,
    idempotent: false,
  };
}

async function resolveApprovalContraAccount(
  client: ApprovalClient,
  companyId: number,
  direction: string,
  candidateType: string | null,
  manualCoaCode: string | null,
): Promise<{ id: number; code: string; name: string }> {
  if (manualCoaCode) {
    const manual = await client.query<{ id: number; code: string; name: string }>(
      `select id, code, name
         from public.chart_of_accounts
        where code = $1
          and (company_id = $2 or company_id is null)
          and coalesce(is_active, true) = true
          and coalesce(is_header, false) = false
          and coalesce(is_postable, true) = true
        order by case when company_id = $2 then 0 else 1 end, id
        limit 1`,
      [manualCoaCode, companyId],
    );
    const account = manual.rows[0];
    if (!account) {
      throw new ApprovalError(
        `Akun COA "${manualCoaCode}" tidak ditemukan atau tidak aktif di perusahaan ini.`,
        422,
        "COA_NOT_FOUND",
      );
    }
    return account;
  }

  const settings = await client.query<{
    ar_account_id: number | null;
    ap_account_id: number | null;
    purchase_expense_account_id: number | null;
  }>(
    `select ar_account_id, ap_account_id, purchase_expense_account_id
       from public.accounting_settings
      where company_id = $1
      limit 1`,
    [companyId],
  );
  const configured = settings.rows[0];
  const type = (candidateType ?? "").toLowerCase();

  // Source-owned inbound candidates must derive their contra account from the
  // already-posted source journal. Falling back to AR here caused duplicate bank
  // debits and negative receivables when Sport Center/Tenant had already posted
  // revenue. Fail closed if this function is ever reached for those candidates.
  if (direction === "IN" && (type === "sport_payment" || type === "tenant_invoice")) {
    throw new ApprovalError(
      "Jurnal sumber wajib digunakan untuk pembayaran Sport Center/Tenant; fallback otomatis ke Piutang Usaha dinonaktifkan.",
      422,
      "SOURCE_JOURNAL_REQUIRED",
    );
  }

  // OUT vendor_invoice: cash payment settles payable.
  // OUT without a payable candidate: use the configured purchase/expense COA.
  let configuredId: number | null | undefined;
  if (direction === "IN") {
    configuredId = undefined;
  } else if (type === "vendor_invoice") {
    configuredId = configured?.ap_account_id;
  } else {
    configuredId = configured?.purchase_expense_account_id;
  }

  if (configuredId != null) {
    const configuredAccount = await client.query<{ id: number; code: string; name: string }>(
      `select id, code, name
         from public.chart_of_accounts
        where id = $1
          and (company_id = $2 or company_id is null)
          and coalesce(is_active, true) = true
          and coalesce(is_header, false) = false
          and coalesce(is_postable, true) = true
        limit 1`,
      [configuredId, companyId],
    );
    const account = configuredAccount.rows[0];
    if (account) return account;
  }

  throw new ApprovalError(
    direction === "IN"
      ? "Akun piutang (AR) belum dikonfigurasi di Accounting Settings. Pilih COA manual sebelum approve."
      : "Akun lawan transaksi belum dikonfigurasi. Pilih COA manual sebelum approve.",
    422,
    "JOURNAL_MAPPING_REQUIRED",
  );
}

async function resolveApprovalBankAccount(
  client: ApprovalClient,
  companyId: number,
  bankAccountReference: string | null,
): Promise<number | null> {
  let coaId: number | null = null;
  if (bankAccountReference) {
    const byCompanyBank = await client.query<{ coa_id: number | null }>(
      `select coa_id
         from public.company_bank_accounts
        where company_id = $1
          and coalesce(is_active, true) = true
          and (
            id::text = $2
            or account_number::text = $2
            or regexp_replace(coalesce(account_number, ''), '[^0-9]', '', 'g') =
               regexp_replace($2, '[^0-9]', '', 'g')
          )
        order by case when id::text = $2 then 0 else 1 end, id
        limit 1`,
      [companyId, bankAccountReference],
    );
    coaId = byCompanyBank.rows[0]?.coa_id ?? null;
  }

  if (coaId == null) {
    const settings = await client.query<{ default_bank_account_id: number | null }>(
      `select default_bank_account_id
         from public.accounting_settings
        where company_id = $1
        limit 1`,
      [companyId],
    );
    const defaultReference = settings.rows[0]?.default_bank_account_id;
    if (defaultReference != null) {
      const defaultAccount = await client.query<{ id: number }>(
        `select resolved.id
           from (
             select cba.coa_id as id, 0 as priority
               from public.company_bank_accounts cba
              where cba.company_id = $1
                and coalesce(cba.is_active, true) = true
                and (cba.id = $2 or cba.coa_id = $2)
                and cba.coa_id is not null
             union all
             select coa.id, 1 as priority
               from public.chart_of_accounts coa
              where coa.id = $2
           ) resolved
          join public.chart_of_accounts coa on coa.id = resolved.id
          where coalesce(coa.is_active, true) = true
            and coalesce(coa.is_header, false) = false
            and coalesce(coa.is_postable, true) = true
          order by resolved.priority
          limit 1`,
        [companyId, defaultReference],
      );
      coaId = defaultAccount.rows[0]?.id ?? null;
    }
  }

  if (coaId == null) return null;
  const valid = await client.query<{ id: number }>(
    `select id
       from public.chart_of_accounts
      where id = $1
        and (company_id = $2 or company_id is null)
        and coalesce(is_active, true) = true
        and coalesce(is_header, false) = false
        and coalesce(is_postable, true) = true
      limit 1`,
    [coaId, companyId],
  );
  return valid.rows[0]?.id ?? null;
}

async function nextApprovalEntryNumber(
  client: ApprovalClient,
  companyId: number,
  year: number,
): Promise<string> {
  const sequence = await client.query<{ claimed_seq: number }>(
    `insert into public.journal_sequences (journal_prefix, company_id, year, next_seq)
     values ('RECON', $1, $2, 2)
     on conflict (journal_prefix, company_id, year)
     do update set next_seq = public.journal_sequences.next_seq + 1
     returning (next_seq - 1)::int as claimed_seq`,
    [companyId, year],
  );
  const claimed = Number(sequence.rows[0]?.claimed_seq ?? 1);
  return `RECON/${year}/${String(claimed).padStart(6, "0")}`;
}

async function assertApprovalCandidateExists(
  client: ApprovalClient,
  candidateType: string | null,
  candidateId: number | null,
  candidateSource: string | null,
  companyId: number,
): Promise<void> {
  if (!candidateType || candidateId == null) return;

  let result: { rows: Array<{ id: number }> };
  if (candidateType === "sport_payment") {
    if (candidateSource && candidateSource !== "sport_center.sport_payments") {
      throw new ApprovalError("Sumber kandidat Sport Center tidak valid.", 409, "STALE_CANDIDATE");
    }
    result = await client.query(
      `select id
         from sport_center.sport_payments
        where id = $1
          and coalesce(company_id, 1) = $2
        limit 1
        for update`,
      [candidateId, companyId],
    );
  } else if (candidateType === "sport_company_invoice") {
    if (candidateSource && candidateSource !== "sport_center.company_invoices") {
      throw new ApprovalError("Sumber kandidat invoice perusahaan Sport Center tidak valid.", 409, "STALE_CANDIDATE");
    }
    result = await client.query(
      `select ci.id
         from sport_center.company_invoices ci
        where ci.id = $1
          and lower(coalesce(nullif(ci.invoice_status, ''), nullif(ci.status, ''), '')) in
              ('paid', 'confirmed', 'completed', 'success', 'settled')
          and exists (
            select 1
              from sport_center.company_invoice_items cii
              join sport_center.sport_bookings sb on sb.id = cii.booking_id
              join sport_center.facility_company_mappings fcm
                on fcm.facility_id = sb.facility_id
               and fcm.company_id = $2
               and fcm.is_active = true
               and fcm.approval_status = 'OWNER_APPROVED'
             where cii.invoice_id = ci.id
          )
        limit 1
        for update`,
      [candidateId, companyId],
    );
  } else if (candidateType === "vendor_invoice") {
    if (candidateSource && candidateSource !== "public.vendor_invoices") {
      throw new ApprovalError("Sumber kandidat vendor tidak valid.", 409, "STALE_CANDIDATE");
    }
    result = await client.query(
      `select id from public.vendor_invoices where id = $1 and company_id = $2 limit 1 for update`,
      [candidateId, companyId],
    );
  } else if (candidateType === "tenant_invoice") {
    if (candidateSource && candidateSource !== "public.tenant_payments") {
      throw new ApprovalError("Sumber kandidat pembayaran tenant tidak valid.", 409, "STALE_CANDIDATE");
    }
    result = await client.query(
      `select id
         from public.tenant_payments
        where id = $1
          and company_id = $2
          and lower(coalesce(status::text, '')) in ('confirmed', 'paid', 'approved', 'completed', 'success', 'settled')
        limit 1
        for update`,
      [candidateId, companyId],
    );
  } else if (candidateType === "recon_rule") {
    if (candidateSource !== "public.recon_rules") {
      throw new ApprovalError("Sumber Rule AI tidak valid.", 409, "STALE_CANDIDATE");
    }
    result = await client.query(
      `select id from public.recon_rules where id = $1 and company_id = $2 and is_active = true limit 1 for update`,
      [candidateId, companyId],
    );
    } else if (candidateType === "qris_settlement") {
    if (candidateSource !== "sport_center.payment_settlement_batches") {
      throw new ApprovalError("QRIS settlement legacy/tanpa source canonical tidak dapat di-approve.", 409, "STALE_CANDIDATE");
    }
    result = await client.query(
      `select id
         from sport_center.payment_settlement_batches
        where id::text = $1::text
          and company_id = $2
        limit 1
        for update`,
      [candidateId, companyId],
    );
  } else {
    throw new ApprovalError(`Tipe kandidat "${candidateType}" tidak didukung untuk approval.`, 409, "STALE_CANDIDATE");
  }

  if (result.rows.length === 0) {
    throw new ApprovalError("Kandidat sudah tidak memiliki source record yang valid. Jalankan matching ulang.", 409, "STALE_CANDIDATE");
  }
}

async function approveCanonicalSettlementLink(
  client: ApprovalClient,
  mutationId: number,
  settlementId: number,
  matchId: number | null,
  actor: ApprovalActor,
  idempotencyKey: string | null,
): Promise<Record<string, unknown>> {
  const mutationResult = await client.query<{
    id: number;
    status: string;
    amount: string;
    direction: string;
    transaction_date: string;
    company_id: number | null;
    bank_account_id: string | number | null;
    journal_entry_id: number | null;
  }>(
    `select id,status,amount,direction,transaction_date::text as transaction_date,
            company_id,bank_account_id,journal_entry_id
       from public.bank_mutations
      where id=$1
      for update`,
    [mutationId],
  );
  const mutation = mutationResult.rows[0];
  if (!mutation || mutation.company_id == null) throw new ApprovalError("Mutasi tidak ditemukan atau tidak memiliki company.", 404, "NOT_FOUND");
  if (actor.companyId != null && actor.companyId !== mutation.company_id) throw new ApprovalError("Mutasi berada di perusahaan yang berbeda.", 403, "COMPANY_SCOPE_FORBIDDEN");

  const batchResult = await client.query<{
    id: number;
    company_id: number;
    bank_account_id: string | null;
    settlement_date: string;
    net_amount: string;
    status: string;
    bank_mutation_id: number | null;
    canonical_bank_mutation_id: number | null;
    settlement_journal_id: number | null;
  }>(
    `select id,company_id,bank_account_id,settlement_date::text as settlement_date,net_amount,
            status::text as status,bank_mutation_id,canonical_bank_mutation_id,settlement_journal_id
       from sport_center.payment_settlement_batches
      where id=$1 and company_id=$2
      for update`,
    [settlementId, mutation.company_id],
  );
  const batch = batchResult.rows[0];
  if (!batch) throw new ApprovalError("Settlement canonical tidak ditemukan.", 409, "STALE_CANDIDATE");
  if (String(mutation.direction ?? "").toUpperCase() !== "IN") {
    throw new ApprovalError("Settlement QRIS canonical hanya dapat ditautkan ke mutasi IN.", 422, "INVALID_DIRECTION");
  }

  const settlementStatus = String(batch.status ?? "").toLowerCase();
  const linkedMutationId = batch.bank_mutation_id ?? batch.canonical_bank_mutation_id;
  const mutationAmount = Number(mutation.amount);
  const settlementAmount = Number(batch.net_amount);
  const amountMatches =
    Number.isFinite(mutationAmount)
    && Number.isFinite(settlementAmount)
    && Math.abs(mutationAmount - settlementAmount) <= 0.01;
  const dateMatches = calendarDateValue(mutation.transaction_date) === calendarDateValue(batch.settlement_date);
  if (
    batch.company_id !== mutation.company_id
    || !amountMatches
    || !dateMatches
    || !["posted", "reconciled"].includes(settlementStatus)
  ) {
    throw new ApprovalError(
      "Settlement canonical tidak memenuhi company/tanggal/net amount/status mutasi.",
      409,
      "CANONICAL_SETTLEMENT_EVIDENCE_INVALID",
      {
        mutation_amount: mutationAmount,
        settlement_net_amount: settlementAmount,
        mutation_date: mutation.transaction_date,
        settlement_date: batch.settlement_date,
        settlement_status: batch.status,
      },
    );
  }
  if (linkedMutationId != null && linkedMutationId !== mutationId) {
    throw new ApprovalError("Settlement sudah digunakan oleh mutasi bank lain.", 409, "CANONICAL_SETTLEMENT_ALREADY_USED");
  }

  const bankAccountResult = await client.query<{ id: number; account_number: string | null }>(
    `select id,account_number
       from public.company_bank_accounts
      where company_id=$1
        and coalesce(is_active,true)=true
        and (
          id::text=$2
          or account_number::text=$2
          or regexp_replace(coalesce(account_number, ''), '[^0-9]', '', 'g') =
             regexp_replace($2, '[^0-9]', '', 'g')
        )
      order by case when id::text=$2 then 0 else 1 end,id
      limit 1`,
    [mutation.company_id, mutation.bank_account_id == null ? "" : String(mutation.bank_account_id)],
  );
  const bankAccount = bankAccountResult.rows[0];
  const normalizeBankAccountNumber = (value: unknown): string => String(value ?? "").replace(/[^0-9]/g, "");
  const mutationBankNumber = normalizeBankAccountNumber(bankAccount?.account_number);
  const settlementBankNumber = normalizeBankAccountNumber(batch.bank_account_id);
  if (!bankAccount || !mutationBankNumber || !settlementBankNumber || mutationBankNumber !== settlementBankNumber) {
    throw new ApprovalError("Rekening settlement dan rekening mutasi tidak sama.", 409, "CANONICAL_SETTLEMENT_BANK_MISMATCH");
  }

  if (mutation.journal_entry_id != null) {
    throw new ApprovalError(
      "Mutasi QRIS canonical memiliki generic bank journal; canonical link diblokir sampai journal drift diperbaiki.",
      409,
      "CANONICAL_GENERIC_JOURNAL_ALREADY_EXISTS",
    );
  }

  if (settlementStatus === "reconciled" && linkedMutationId === mutationId) {
    return { ok: true, status: "approved", settlement_id: settlementId, journal_entry_id: null, idempotent: true };
  }
  if (settlementStatus !== "posted" || linkedMutationId != null || batch.settlement_journal_id == null) {
    throw new ApprovalError("Settlement canonical tidak lagi eligible untuk reconciliation.", 409, "CANONICAL_SETTLEMENT_NOT_ELIGIBLE");
  }

  const journalResult = await client.query<{ status: string; company_id: number | null; journal_type: string; is_reversal: boolean }>(
    `select status,company_id,journal_type::text as journal_type,is_reversal
       from sport_center.accounting_journals
      where id=$1 for update`,
    [batch.settlement_journal_id],
  );
  const journal = journalResult.rows[0];
  if (
    !journal
    || journal.status !== "posted"
    || journal.company_id !== mutation.company_id
    || journal.journal_type !== "settlement"
    || journal.is_reversal
  ) {
    throw new ApprovalError("Jurnal settlement canonical tidak valid atau belum posted.", 409, "CANONICAL_SETTLEMENT_JOURNAL_INVALID");
  }

  const invalidPayment = await client.query<{ id: number }>(
    `select item.payment_id as id
       from sport_center.payment_settlement_items item
       join sport_center.sport_payments payment on payment.id=item.payment_id
      where item.settlement_id=$1
        and item.item_status='active'
        and (
          lower(coalesce(payment.status::text,'')) <> 'confirmed'
          or lower(coalesce(payment.payment_method::text,'')) not like '%qris%'
        )
      limit 1
      for update of item,payment`,
    [settlementId],
  );
  const itemCount = await client.query<{ count: string }>(
    `select count(*)::text as count
       from sport_center.payment_settlement_items
      where settlement_id=$1 and item_status='active'`,
    [settlementId],
  );
  if (Number(itemCount.rows[0]?.count ?? 0) < 1 || invalidPayment.rows[0]) {
    throw new ApprovalError("Payment settlement tidak seluruhnya QRIS confirmed aktif.", 409, "CANONICAL_SETTLEMENT_PAYMENT_INVALID");
  }

  const otherMutationLink = await client.query<{ id: number }>(
    `select id from sport_center.payment_settlement_batches
      where (bank_mutation_id=$1 or canonical_bank_mutation_id=$1) and id<>$2 limit 1 for update`,
    [mutationId, settlementId],
  );
  if (otherMutationLink.rows[0]) throw new ApprovalError("Mutasi sudah tertaut ke settlement canonical lain.", 409, "CONFLICT");

  const otherApproved = await client.query<{ id: number }>(
    `select id from public.bank_reconciliation_matches
      where mutation_id=$1 and status='approved' and ($2::bigint is null or id<>$2) limit 1 for update`,
    [mutationId, matchId],
  );
  if (otherApproved.rows[0]) throw new ApprovalError("Mutasi sudah memiliki approved match lain.", 409, "CONFLICT");

  await client.query(
    `update sport_center.payment_settlement_batches
        set status='reconciled',bank_mutation_id=$2,reconciled_at=now(),reconciled_by=$3
      where id=$1 and status='posted' and bank_mutation_id is null`,
    [settlementId, mutationId, actor.email],
  );

  if (matchId != null) {
    await client.query(
      `update public.bank_reconciliation_matches
          set status='approved',candidate_source='sport_center.payment_settlement_batches'
        where id=$1 and mutation_id=$2 and candidate_type='qris_settlement' and candidate_id=$3`,
      [matchId, mutationId, settlementId],
    );
    await client.query(
      `update public.bank_reconciliation_matches set status='superseded'
        where mutation_id=$1 and id<>$2 and status not in ('approved','posted')`,
      [mutationId, matchId],
    );
  } else {
    await client.query(
      `update public.bank_reconciliation_matches set status='superseded'
        where mutation_id=$1 and status not in ('approved','posted')`,
      [mutationId],
    );
    await client.query(
      `insert into public.bank_reconciliation_matches
        (mutation_id,candidate_type,candidate_id,match_score,match_reason,amount_match,date_match,name_match,order_id_match,proof_match,status,candidate_source)
       values($1,'qris_settlement',$2,100,'canonical settlement link-only approval',true,true,false,false,false,'approved','sport_center.payment_settlement_batches')`,
      [mutationId, settlementId],
    );
  }

  await client.query(
    `update public.bank_mutations
        set status='approved',reconciliation_status='approved',journal_entry_id=null,
            approved_by=$2,approved_at=coalesce(approved_at,now()),updated_at=now()
      where id=$1`,
    [mutationId, actor.email],
  );
  await client.query(
    `insert into public.bank_reconciliation_audit(mutation_id,action,actor,meta)
     values($1,'CANONICAL_SETTLEMENT_LINK_APPROVED',$2,$3::jsonb)`,
    [mutationId, actor.email, JSON.stringify({ settlement_id: settlementId, candidate_source: "sport_center.payment_settlement_batches", link_only: true, idempotency_key: idempotencyKey })],
  );
  return { ok: true, status: "approved", settlement_id: settlementId, journal_entry_id: null, idempotent: false };
}

async function approveBankMutation(
  client: ApprovalClient,
  mutationId: number,
  body: ApprovalBody,
  actor: ApprovalActor,
  idempotencyKey: string | null,
): Promise<Record<string, unknown>> {
  const matchId = safeInteger(body.match_id);
  const candidateId = safeInteger(body.candidate_id);
  const candidateType = textValue(body.candidate_type);
  const requestedSource = textValue(body.candidate_source);
  const note = textValue(body.note);
  const manualCoaCode = textValue(body.manual_coa_code);

  const mutationResult = await client.query<{
    id: number;
    status: string;
    amount: string;
    direction: string;
    transaction_date: string;
    description: string;
    mutation_key: string | null;
    bank_reference: string | null;
    canonical_key: string | null;
    provider_order_id: string | null;
    company_id: number | null;
    bank_account_id: string | number | null;
    journal_entry_id: number | null;
  }>(
    `select id, status, amount, direction, transaction_date::text as transaction_date, description,
            mutation_key, bank_reference, canonical_key, provider_order_id,
            company_id, bank_account_id, journal_entry_id
       from public.bank_mutations
      where id = $1
      for update`,
    [mutationId],
  );
  const mutation = mutationResult.rows[0];
  if (!mutation) throw new ApprovalError("Mutasi tidak ditemukan", 404, "NOT_FOUND");
  if (mutation.company_id == null) {
    throw new ApprovalError("Mutasi tidak memiliki company_id yang valid; approval diblokir.", 422, "COMPANY_SCOPE_REQUIRED");
  }
  if (actor.companyId != null && actor.companyId !== mutation.company_id) {
    throw new ApprovalError("Mutasi berada di perusahaan yang berbeda.", 403, "COMPANY_SCOPE_FORBIDDEN");
  }

  const amount = Number(mutation.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ApprovalError("Nominal mutasi tidak valid.", 422, "INVALID_AMOUNT");
  }
  const direction = String(mutation.direction ?? "").toUpperCase() === "OUT" ? "OUT" : "IN";

  if (["approved_pending_posting", "approved", "posted"].includes(mutation.status)) {
    // Canonical QRIS reconciliation is link-only and intentionally has no
    // public.accounting_entries journal. Its journal is owned by sport_center.
    if (mutation.journal_entry_id == null) {
      const canonicalQris = await client.query<{ settlement_id: number }>(
        `select psb.id as settlement_id
           from sport_center.payment_settlement_batches psb
          where psb.bank_mutation_id = $1
            and psb.company_id = $2
            and psb.status = 'reconciled'
            and psb.settlement_journal_id is not null
          limit 1`,
        [mutationId, mutation.company_id],
      );
      const linkedSettlement = canonicalQris.rows[0];
      if (linkedSettlement) {
        return {
          ok: true,
          status: mutation.status,
          settlement_id: linkedSettlement.settlement_id,
          journal_entry_id: null,
          idempotent: true,
        };
      }
      throw new ApprovalError("Mutasi sudah approved tetapi tidak memiliki jurnal canonical yang valid.", 409, "APPROVAL_STATE_INVALID");
    }
    return {
      ok: true,
      journal_entry_id: mutation.journal_entry_id,
      status: mutation.status,
      idempotent: true,
    };
  }
  if (!["unmatched", "matched", "manual_review", "duplicate_need_review"].includes(mutation.status)) {
    throw new ApprovalError(`Mutasi dengan status "${mutation.status}" tidak dapat di-approve.`, 409, "INVALID_STATUS");
  }

  let selectedCandidateType = candidateType;
  let selectedCandidateId = candidateId;
  let selectedCandidateSource = requestedSource;
  if (matchId != null) {
    const matchResult = await client.query<{
      candidate_type: string;
      candidate_id: number;
      candidate_source: string | null;
      status: string;
    }>(
      `select candidate_type, candidate_id, candidate_source, status
         from public.bank_reconciliation_matches
        where id = $1 and mutation_id = $2
        for update`,
      [matchId, mutationId],
    );
    const match = matchResult.rows[0];
    if (!match) throw new ApprovalError("Kandidat rekonsiliasi tidak ditemukan untuk mutasi ini.", 409, "MATCH_NOT_FOUND");
    selectedCandidateType = match.candidate_type;
    selectedCandidateId = match.candidate_id;
    if (requestedSource && match.candidate_source && requestedSource !== match.candidate_source) {
      throw new ApprovalError("candidate_source tidak sama dengan source kandidat tersimpan.", 409, "CANDIDATE_SOURCE_MISMATCH");
    }
    selectedCandidateSource = match.candidate_source;
    if (!selectedCandidateSource) {
      throw new ApprovalError(
        "Kandidat lama tanpa candidate_source canonical tidak dapat di-approve. Jalankan matching ulang.",
        409,
        "STALE_CANDIDATE",
      );
    }
  }

  const approvedMatch = await client.query<{ id: number }>(
    `select id
       from public.bank_reconciliation_matches
      where mutation_id = $1 and status = 'approved'
      limit 1
      for update`,
    [mutationId],
  );
  if (approvedMatch.rows.length > 0 && approvedMatch.rows[0]?.id !== matchId) {
    throw new ApprovalError("Kandidat lain sudah di-approve untuk mutasi ini.", 409, "CONFLICT");
  }

  const companyId = mutation.company_id;
  if (selectedCandidateType && selectedCandidateId != null && !selectedCandidateSource) {
    selectedCandidateSource = selectedCandidateType === "sport_payment"
      ? "sport_center.sport_payments"
      : selectedCandidateType === "sport_company_invoice"
        ? "sport_center.company_invoices"
        : selectedCandidateType === "vendor_invoice"
        ? "public.vendor_invoices"
        : selectedCandidateType === "tenant_invoice"
          ? "public.tenant_payments"
          : selectedCandidateType === "recon_rule"
            ? "public.recon_rules"
            : null;
  }
  await assertApprovalCandidateExists(
    client,
    selectedCandidateType,
    selectedCandidateId,
    selectedCandidateSource,
    companyId,
  );
  if (selectedCandidateType === "sport_company_invoice") {
    throw new ApprovalError(
      "Invoice perusahaan Sport Center sudah cocok dengan mutasi bank, tetapi approval accounting otomatis belum diaktifkan untuk source corporate invoice. Matching tetap disimpan; posting diblokir agar tidak menggandakan pendapatan.",
      422,
      "SPORT_COMPANY_INVOICE_ACCOUNTING_REVIEW_REQUIRED",
    );
  }
  if (
    selectedCandidateType === "qris_settlement"
    && selectedCandidateId != null
    && selectedCandidateSource === "sport_center.payment_settlement_batches"
  ) {
    return approveCanonicalSettlementLink(
      client,
      mutationId,
      selectedCandidateId,
      matchId,
      actor,
      idempotencyKey,
    );
  }
  const bankCoaId = await resolveApprovalBankAccount(
    client,
    companyId,
    mutation.bank_account_id == null ? null : String(mutation.bank_account_id),
  );
  if (bankCoaId == null) {
    throw new ApprovalError(
      "Akun bank/kas tidak ditemukan. Konfigurasikan akun bank perusahaan terlebih dahulu.",
      422,
      "COA_NOT_FOUND",
    );
  }
  let sourceReceiptJournal: SourceReceiptJournal | null = null;
  if (
    direction === "IN"
    && isSourceOwnedInboundCandidate(selectedCandidateType)
    && selectedCandidateId != null
  ) {
    if (manualCoaCode) {
      throw new ApprovalError(
        "COA manual tidak boleh menggantikan jurnal sumber Sport Center/Tenant. Perbaiki jurnal sumber bila mapping akuntansinya salah.",
        422,
        "SOURCE_OWNED_COA_OVERRIDE_BLOCKED",
      );
    }
    await assertSourceOwnedCandidateNotReconciledElsewhere(
      client,
      mutationId,
      selectedCandidateType!,
      selectedCandidateId,
      selectedCandidateSource!,
    );
    sourceReceiptJournal = await resolvePostedSourceReceiptJournal(
      client,
      companyId,
      selectedCandidateType!,
      selectedCandidateId,
      amount,
    );
    if (selectedCandidateType === "sport_payment") {
      await assertSportPaymentSourceReceiptAccount(
        client,
        companyId,
        selectedCandidateId,
        sourceReceiptJournal,
      );
    }

    if (sourceReceiptJournal.debitAccountId === bankCoaId) {
      return finalizeSourceJournalReuse(
        client,
        mutationId,
        companyId,
        matchId,
        selectedCandidateType!,
        selectedCandidateId,
        selectedCandidateSource!,
        sourceReceiptJournal,
        actor,
      );
    }
  }

  const contra = sourceReceiptJournal
    ? {
        id: sourceReceiptJournal.debitAccountId,
        code: sourceReceiptJournal.debitAccountCode,
        name: sourceReceiptJournal.debitAccountName,
      }
    : await resolveApprovalContraAccount(
        client,
        companyId,
        direction,
        selectedCandidateType,
        manualCoaCode,
      );

  const journalResult = await client.query<{ id: number; code: string }>(
    `select id, code
       from public.accounting_journals
      where company_id = $1
        and (lower(name) like '%bank%' or lower(code) like '%bank%' or type = 'bank')
      order by id
      limit 1`,
    [companyId],
  );
  const journal = journalResult.rows[0];
  if (!journal) {
    throw new ApprovalError(
      "Jurnal bank belum dikonfigurasi untuk perusahaan ini.",
      422,
      "JOURNAL_MAPPING_REQUIRED",
    );
  }

  const existingEntry = await client.query<{ id: number; entry_number: string; status: string }>(
    `select id, entry_number, status
       from public.accounting_entries
      where company_id = $1
        and source = 'bank_reconciliation'
        and source_id = $2
      limit 1
      for update`,
    [companyId, mutationId],
  );
  let entryId: number;
  let entryNumber: string;
  if (existingEntry.rows[0]) {
    entryId = existingEntry.rows[0].id;
    entryNumber = existingEntry.rows[0].entry_number;
  } else {
    const txDate = calendarDateValue(mutation.transaction_date);
    if (!txDate) {
      throw new ApprovalError(
        "Tanggal transaksi mutasi tidak valid; approval diblokir.",
        422,
        "INVALID_TRANSACTION_DATE",
      );
    }
    const year = Number(txDate.slice(0, 4)) || new Date().getUTCFullYear();
    entryNumber = await nextApprovalEntryNumber(client, companyId, year);
    const reference = mutation.mutation_key ?? mutation.bank_reference ?? mutation.canonical_key ?? String(mutationId);
    const description = String(mutation.description ?? "").slice(0, 200);
    const inserted = await client.query<{ id: number; entry_number: string }>(
      `insert into public.accounting_entries
        (entry_number, journal_id, date, ref, description, status, source, source_id,
         total_debit, total_credit, created_by_id, company_id)
       values ($1, $2, $3, $4, $5, 'draft', 'bank_reconciliation', $6,
               $7, $7, $8, $9)
       returning id, entry_number`,
      [entryNumber, journal.id, txDate, reference, description, mutationId, amount, actor.email, companyId],
    );
    const insertedEntry = inserted.rows[0];
    if (!insertedEntry) throw new Error("Jurnal gagal dibuat.");
    entryId = insertedEntry.id;
    entryNumber = insertedEntry.entry_number;

    const lineDescription = (
      sourceReceiptJournal
        ? `Reklasifikasi penerimaan dari ${sourceReceiptJournal.debitAccountCode} ke bank mutasi — ${note ?? description ?? `Rekon ${mutationId}`}`
        : (note ?? description ?? `Rekon ${mutationId}`)
    ).slice(0, 200);
    if (direction === "IN") {
      await client.query(
        `insert into public.accounting_entry_lines
          (entry_id, account_id, debit, credit, description)
         values ($1, $2, $3, 0, $4), ($1, $5, 0, $3, $4)`,
        [entryId, bankCoaId, amount, lineDescription, contra.id],
      );
    } else {
      await client.query(
        `insert into public.accounting_entry_lines
          (entry_id, account_id, debit, credit, description)
         values ($1, $2, $3, 0, $4), ($1, $5, 0, $3, $4)`,
        [entryId, contra.id, amount, lineDescription, bankCoaId],
      );
    }
  }

  await client.query(
    `update public.bank_mutations
        set status = 'approved_pending_posting',
            reconciliation_status = 'matched',
            journal_entry_id = $1,
            approved_by = $2,
            approved_at = now(),
            linked_transaction_type = case when $4::boolean then $5 else linked_transaction_type end,
            linked_transaction_id = case when $4::boolean then $6 else linked_transaction_id end,
            updated_at = now()
      where id = $3`,
    [
      entryId,
      actor.email,
      mutationId,
      sourceReceiptJournal != null,
      sourceReceiptJournal ? selectedCandidateType : null,
      sourceReceiptJournal ? selectedCandidateId : null,
    ],
  );

  if (matchId != null) {
    await client.query(
      `update public.bank_reconciliation_matches
          set status = 'superseded'
        where mutation_id = $1
          and id <> $2
          and status not in ('approved', 'posted')`,
      [mutationId, matchId],
    );
    await client.query(
      `update public.bank_reconciliation_matches
          set status = 'approved',
              candidate_source = coalesce(candidate_source, $3)
        where id = $1 and mutation_id = $2`,
      [matchId, mutationId, selectedCandidateSource],
    );
  } else if (manualCoaCode) {
    await client.query(
      `update public.bank_reconciliation_matches
          set status = 'superseded'
        where mutation_id = $1
          and status not in ('approved', 'posted')`,
      [mutationId],
    );
  } else if (selectedCandidateType && selectedCandidateId != null) {
    await client.query(
      `insert into public.bank_reconciliation_matches
        (mutation_id, candidate_type, candidate_id, match_score, match_reason,
         amount_match, date_match, name_match, order_id_match, proof_match,
         status, candidate_source)
       values ($1, $2, $3, 100, 'manual approve', true, false, false, false, false,
               'approved', $4)
       on conflict do nothing`,
      [mutationId, selectedCandidateType, selectedCandidateId, selectedCandidateSource],
    );
  }

  await client.query(
    `insert into public.bank_reconciliation_audit
      (mutation_id, action, actor, meta)
     values ($1, 'MATCH_APPROVED', $2, $3::jsonb)`,
    [
      mutationId,
      actor.email,
      JSON.stringify({
        match_id: matchId,
        candidate_type: selectedCandidateType,
        candidate_id: selectedCandidateId,
        candidate_source: selectedCandidateSource,
        journal_entry_id: entryId,
        entry_number: entryNumber,
        bank_coa_id: bankCoaId,
        contra_coa_id: contra.id,
        amount,
        direction,
        note,
        manual_coa_override: manualCoaCode != null,
        source_journal_id: sourceReceiptJournal?.entryId ?? null,
        source_journal_number: sourceReceiptJournal?.entryNumber ?? null,
        idempotency_key: idempotencyKey,
      }),
    ],
  );

  return {
    ok: true,
    journal_entry_id: entryId,
    journal_entry_number: entryNumber,
    status: "approved_pending_posting",
  };
}

async function postBankMutationCanonical(
  client: ApprovalClient,
  mutationId: number,
  entryId: number,
  matchId: number | null,
  actor: ApprovalActor,
  meta: Record<string, unknown>,
): Promise<{ journal_entry_id: number; status: "posted"; idempotent: boolean }> {
  const locked = await client.query<{ status: string; journal_entry_id: number | null; company_id: number | null }>(
    `select status, journal_entry_id, company_id from public.bank_mutations where id=$1 for update`,
    [mutationId],
  );
  const mutation = locked.rows[0];
  if (!mutation) throw new ApprovalError("Mutasi tidak ditemukan.", 404, "NOT_FOUND");
  if (actor.companyId != null && mutation.company_id !== actor.companyId) {
    throw new ApprovalError("Mutasi berada di perusahaan yang berbeda.", 403, "COMPANY_SCOPE_FORBIDDEN");
  }
  if (mutation.status === "posted" && mutation.journal_entry_id != null) {
    return { journal_entry_id: mutation.journal_entry_id, status: "posted", idempotent: true };
  }
  if (mutation.journal_entry_id !== entryId) {
    throw new ApprovalError("Jurnal approval tidak sama dengan jurnal mutasi.", 409, "JOURNAL_ID_MISMATCH");
  }
  const entry = await client.query<{ status: string; total_debit: string; total_credit: string }>(
    `select status,total_debit,total_credit from public.accounting_entries
      where id=$1 and company_id=$2 and source='bank_reconciliation' and source_id=$3
      for update`,
    [entryId, mutation.company_id, mutationId],
  );
  const journal = entry.rows[0];
  if (!journal) throw new ApprovalError("Jurnal canonical tidak ditemukan.", 409, "CANONICAL_JOURNAL_MISSING");
  const lines = await client.query<{ debit: string; credit: string }>(
    `select debit,credit from public.accounting_entry_lines where entry_id=$1 for update`,
    [entryId],
  );
  const debit = lines.rows.reduce((sum,row)=>sum+Number(row.debit||0),0);
  const credit = lines.rows.reduce((sum,row)=>sum+Number(row.credit||0),0);
  if (lines.rows.length < 2 || !Number.isFinite(debit) || !Number.isFinite(credit) || debit <= 0 || Math.abs(debit-credit) > 0.0001) {
    throw new ApprovalError("Jurnal tidak balanced; posting dibatalkan.", 409, "UNBALANCED_JOURNAL");
  }
  if (Math.abs(Number(journal.total_debit)-debit) > 0.0001 || Math.abs(Number(journal.total_credit)-credit) > 0.0001) {
    throw new ApprovalError("Total header jurnal tidak sama dengan journal lines.", 409, "JOURNAL_TOTAL_MISMATCH");
  }
  if (matchId != null) {
    const selected = await client.query<{ id: number }>(
      `select id from public.bank_reconciliation_matches where id=$1 and mutation_id=$2 for update`,
      [matchId, mutationId],
    );
    if (!selected.rows[0]) throw new ApprovalError("Approved match canonical tidak ditemukan.", 409, "MATCH_NOT_FOUND");
  }
  const otherFinal = await client.query<{ id: number }>(
    `select id from public.bank_reconciliation_matches
      where mutation_id=$1
        and ($2::bigint is null or id<>$2)
        and status in ('approved','posted')
      limit 1 for update`,
    [mutationId, matchId],
  );
  if (otherFinal.rows[0]) throw new ApprovalError("Mutasi sudah memiliki final match lain.", 409, "CONFLICT");

  if (journal.status === "draft") {
    await client.query(
      `update public.accounting_entries set status='posted',posted_at=coalesce(posted_at,now()) where id=$1 and status='draft'`,
      [entryId],
    );
  } else if (journal.status !== "posted") {
    throw new ApprovalError(`Jurnal berstatus "${journal.status}" tidak dapat diposting.`, 409, "INVALID_JOURNAL_STATUS");
  }
  if (matchId != null) {
    await client.query(`update public.bank_reconciliation_matches set status='approved' where id=$1`, [matchId]);
    await client.query(
      `update public.bank_reconciliation_matches set status='superseded'
        where mutation_id=$1 and id<>$2 and status not in ('approved','posted')`,
      [mutationId, matchId],
    );
  } else {
    await client.query(
      `update public.bank_reconciliation_matches set status='superseded'
        where mutation_id=$1 and status not in ('approved','posted')`,
      [mutationId],
    );
  }
  await client.query(
    `update public.bank_mutations
        set status='posted',reconciliation_status='reconciled',accounting_posted=true,
            journal_entry_id=$2,posted_at=coalesce(posted_at,now()),approved_at=coalesce(approved_at,now()),
            review_code=$4,review_reason=$3,updated_at=now()
      where id=$1`,
    [
      mutationId,
      entryId,
      String(meta.reason ?? "Canonical bank reconciliation posting"),
      String(meta.review_code ?? "CANONICAL_POSTED"),
    ],
  );
  await client.query(
    `insert into public.bank_reconciliation_audit(mutation_id,action,actor,meta)
      values($1,'CANONICAL_POSTED',$2,$3::jsonb)`,
    [mutationId, actor.email, JSON.stringify({ ...meta, journal_entry_id: entryId, match_id: matchId, contract: "bank-reconciliation-canonical-v1" })],
  );
  return { journal_entry_id: entryId, status: "posted", idempotent: false };
}


router.get("/bank-reconciliation/:mutationId/journal-entry", async (req, res): Promise<void> => {
  const actor = await getApprovalActor(req).catch(() => null);
  if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
  const mutationId = parsePositiveInt(req.params.mutationId);
  if (mutationId === null) { res.status(400).json({ error: "ID mutasi tidak valid" }); return; }

  try {
    const mutationResult = await pool.query<{
      journal_entry_id: number | null;
      company_id: number | null;
      review_code: string | null;
    }>(
      `select journal_entry_id, company_id, review_code
         from public.bank_mutations
        where id=$1 and ($2::int is null or company_id=$2)
        limit 1`,
      [mutationId, actor.companyId],
    );
    const mutation = mutationResult.rows[0];
    if (!mutation) { res.status(404).json({ error: "Mutasi tidak ditemukan" }); return; }
    if (mutation.journal_entry_id == null) {
      res.status(404).json({ error: "Mutasi belum memiliki journal entry" });
      return;
    }

    const entryResult = await pool.query<{
      id: number;
      status: string;
      ref: string | null;
      total_debit: string;
      total_credit: string;
    }>(
      `select id,status::text status,ref,total_debit::text total_debit,total_credit::text total_credit
         from public.accounting_entries
        where id=$1
          and company_id=$2
          and (
            (source='bank_reconciliation' and source_id=$3)
            or $4::text in ('SOURCE_JOURNAL_REUSED','SOURCE_JOURNAL_RECLASSIFIED')
          )
        limit 1`,
      [mutation.journal_entry_id, mutation.company_id, mutationId, mutation.review_code],
    );
    const entry = entryResult.rows[0];
    if (!entry) { res.status(404).json({ error: "Journal entry mutasi tidak ditemukan" }); return; }

    const linesResult = await pool.query<{
      id: number;
      account_id: number;
      account_code: string | null;
      account_name: string | null;
      debit: string;
      credit: string;
      description: string | null;
    }>(
      `select l.id,l.account_id,a.code account_code,a.name account_name,
              l.debit::text debit,l.credit::text credit,l.description
         from public.accounting_entry_lines l
         left join public.chart_of_accounts a on a.id=l.account_id
        where l.entry_id=$1
        order by l.id`,
      [mutation.journal_entry_id],
    );

    res.json({
      id: entry.id,
      status: entry.status,
      ref: entry.ref,
      totalDebit: Number(entry.total_debit ?? 0),
      totalCredit: Number(entry.total_credit ?? 0),
      lines: linesResult.rows.map((line) => ({
        id: line.id,
        accountId: line.account_id,
        accountCode: line.account_code,
        accountName: line.account_name,
        debit: line.debit,
        credit: line.credit,
        description: line.description,
      })),
    });
  } catch (error) {
    req.log.error({ error, mutationId }, "Failed to load reconciliation journal entry");
    res.status(503).json({ error: "Journal entry rekonsiliasi tidak dapat dimuat" });
  }
});

router.post("/bank-reconciliation/:mutationId/post", async (req, res): Promise<void> => {
  const actor = await getApprovalActor(req).catch(() => null);
  if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
  const mutationId = parsePositiveInt(req.params.mutationId);
  if (mutationId === null) { res.status(400).json({ error: "ID mutasi tidak valid" }); return; }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const mutationResult = await client.query<{
      status: string;
      journal_entry_id: number | null;
    }>(
      `select status,journal_entry_id
         from public.bank_mutations
        where id=$1
        for update`,
      [mutationId],
    );
    const mutation = mutationResult.rows[0];
    if (!mutation) throw new ApprovalError("Mutasi tidak ditemukan.", 404, "NOT_FOUND");

    if (mutation.status === "posted" && mutation.journal_entry_id != null) {
      await client.query("commit");
      res.json({ ok: true, status: "posted", journal_entry_id: mutation.journal_entry_id, idempotent: true });
      return;
    }
    if (mutation.status !== "approved_pending_posting" || mutation.journal_entry_id == null) {
      throw new ApprovalError("Mutasi belum berada pada status menunggu posting.", 409, "INVALID_STATUS");
    }

    const approvedMatchResult = await client.query<{
      id: number;
      candidate_type: string;
      candidate_source: string | null;
    }>(
      `select id,candidate_type,candidate_source
         from public.bank_reconciliation_matches
        where mutation_id=$1 and status='approved'
        order by id desc
        limit 2
        for update`,
      [mutationId],
    );
    if (approvedMatchResult.rows.length > 1) {
      throw new ApprovalError(
        "Lebih dari satu approved match ditemukan; posting diblokir.",
        409,
        "CONFLICT",
      );
    }
    let approvedMatch = approvedMatchResult.rows[0] ?? null;
    if (!approvedMatch) {
      const draftEntry = await client.query<{ source: string; source_id: number | null }>(
        `select source,source_id from public.accounting_entries
          where id=$1 and company_id=$2 and status='draft'
          for update`,
        [mutation.journal_entry_id, actor.companyId],
      );
      const entry = draftEntry.rows[0];
      if (entry?.source !== "bank_reconciliation" || Number(entry.source_id) !== mutationId) {
        throw new ApprovalError(
          "Approved match tidak ditemukan dan draft jurnal bukan milik mutasi ini.",
          409,
          "MATCH_NOT_FOUND",
        );
      }
      const recoverableMatch = await client.query<{ id: number; candidate_type: string; candidate_source: string | null }>(
        `select id,candidate_type,candidate_source
           from public.bank_reconciliation_matches
          where mutation_id=$1
            and candidate_source is not null
            and status in ('candidate','matched','selected')
          order by match_score desc nulls last,id desc
          limit 2
          for update`,
        [mutationId],
      );
      if (recoverableMatch.rows.length > 1) {
        throw new ApprovalError(
          "Approved match tidak ditemukan dan terdapat lebih dari satu kandidat yang dapat dipulihkan.",
          409,
          "CONFLICT",
        );
      }
      if (recoverableMatch.rows.length === 1) {
        approvedMatch = recoverableMatch.rows[0]!;
        await client.query(
          `update public.bank_reconciliation_matches set status='approved' where id=$1 and mutation_id=$2`,
          [approvedMatch.id, mutationId],
        );
        await client.query(
          `insert into public.bank_reconciliation_audit(mutation_id,action,actor,meta)
           values($1,'APPROVED_MATCH_REPAIRED',$2,$3::jsonb)`,
          [mutationId, actor.email, JSON.stringify({ match_id: approvedMatch.id, journal_entry_id: mutation.journal_entry_id, reason: "Draft jurnal canonical existed but approved match status was missing." })],
        );
      } else {
        const governedDirectAllocation = await client.query<{ id: number }>(
          `select id
             from public.bank_reconciliation_audit
            where mutation_id=$1
              and action='MATCH_APPROVED'
              and coalesce(meta->>'manual_coa_override','false')='true'
              and nullif(meta->>'journal_entry_id','')::bigint=$2
            order by id desc
            limit 1
            for update`,
          [mutationId, mutation.journal_entry_id],
        );
        if (!governedDirectAllocation.rows[0]) {
          throw new ApprovalError(
            "Approved match tidak ditemukan dan direct-bank allocation yang sah tidak ditemukan.",
            409,
            "MATCH_NOT_FOUND",
          );
        }
      }
    }
    if (
      approvedMatch?.candidate_type === "qris_settlement"
      && approvedMatch.candidate_source === "sport_center.payment_settlement_batches"
    ) {
      throw new ApprovalError(
        "Settlement QRIS canonical harus direconcile melalui lifecycle settlement, bukan generic bank journal posting.",
        409,
        "CANONICAL_SETTLEMENT_GENERIC_POST_BLOCKED",
      );
    }

    const sourceOwnedReclassification =
      approvedMatch?.candidate_type === "sport_payment"
      || approvedMatch?.candidate_type === "tenant_invoice";
    const result = await postBankMutationCanonical(
      client,
      mutationId,
      mutation.journal_entry_id,
      approvedMatch?.id ?? null,
      actor,
      {
        reason: sourceOwnedReclassification
          ? "Reklasifikasi akun penerimaan jurnal sumber ke rekening bank mutasi."
          : "Draft jurnal rekonsiliasi diposting melalui canonical bank posting contract.",
        review_code: sourceOwnedReclassification
          ? "SOURCE_JOURNAL_RECLASSIFIED"
          : "CANONICAL_POSTED",
        trigger: "manual-post",
      },
    );

    await client.query("commit");
    res.json({ ok: true, ...result });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (error instanceof ApprovalError) {
      res.status(error.status).json({ error: error.message, code: error.code ?? null });
      return;
    }
    const dbError = error as { code?: string; message?: string; detail?: string };
    req.log.error({ error, mutationId }, "Canonical bank posting failed");
    res.status(dbError.code === "P0001" ? 409 : 503).json({
      error: dbError.message ?? "Posting jurnal rekonsiliasi gagal",
      code: dbError.code ?? "BANK_RECONCILIATION_POST_FAILED",
      detail: dbError.detail ?? null,
    });
  } finally {
    client.release();
  }
});

router.get("/bank-reconciliation/:mutationId/repair-diagnosis", async (req, res): Promise<void> => {
  const actor = await getApprovalActor(req).catch(() => null);
  if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
  const mutationId = parsePositiveInt(req.params.mutationId);
  if (mutationId === null) { res.status(400).json({ error: "ID mutasi tidak valid" }); return; }
  const client = await pool.connect();
  try {
    const mutationResult = await client.query<any>(
      `select id, company_id, status, journal_entry_id, review_code, review_reason,
              mutation_key, description
         from public.bank_mutations
        where id=$1 and ($2::bigint is null or company_id=$2)
        limit 1`, [mutationId, actor.companyId],
    );
    const mutation = mutationResult.rows[0];
    if (!mutation) { res.status(404).json({ error: "Mutasi tidak ditemukan" }); return; }
    const matchResult = await client.query<any>(
      `select id, mutation_id, candidate_id, candidate_type, candidate_source,
              status, match_score, match_reason
         from public.bank_reconciliation_matches
        where mutation_id=$1
        order by case when status in ('approved','posted') then 0 else 1 end, id desc
        limit 1`, [mutationId],
    );
    const match = matchResult.rows[0] ?? null;
    let journal: any = null;
    if (mutation.journal_entry_id != null) {
      const journalResult = await client.query<any>(
        `select id, company_id, status, source, source_id,
                total_debit, total_credit, date::text as date
           from public.accounting_entries where id=$1 limit 1`, [mutation.journal_entry_id],
      ).catch(() => ({ rows: [] as any[] }));
      journal = journalResult.rows[0] ?? null;
    }
    const resolved =
      mutation.status === 'posted'
      && mutation.journal_entry_id != null
      && journal?.status === 'posted';
    const staleJournal = mutation.journal_entry_id != null && journal == null;
    const linkedJournalNotPosted =
      mutation.journal_entry_id != null
      && journal != null
      && journal.status !== 'posted';
    const developerActionRequired = staleJournal || linkedJournalNotPosted;
    const diagnosis = {
      mutation: {
        id: mutation.id, companyId: mutation.company_id, status: mutation.status,
        journalEntryId: mutation.journal_entry_id, reviewCode: mutation.review_code,
        reviewReason: mutation.review_reason, mutationKey: mutation.mutation_key,
        description: mutation.description,
      },
      match: match ? {
        id: match.id, mutationId: match.mutation_id, candidateId: String(match.candidate_id),
        candidateType: match.candidate_type, candidateSource: match.candidate_source,
        status: match.status, matchScore: match.match_score, matchReason: match.match_reason,
      } : null,
      journal,
      disposition: resolved ? 'resolved' : developerActionRequired ? 'developer_action_required' : 'auto_repair',
      code: resolved
        ? 'RECONCILIATION_RESOLVED'
        : staleJournal
          ? 'STALE_JOURNAL_REFERENCE'
          : linkedJournalNotPosted
            ? 'LINKED_JOURNAL_NOT_POSTED'
            : 'REMATCH_REQUIRED',
      title: resolved
        ? 'Rekonsiliasi sudah selesai'
        : staleJournal
          ? 'Referensi jurnal stale'
          : linkedJournalNotPosted
            ? 'Jurnal tertaut tidak berstatus posted'
            : 'Evaluasi ulang Rule AI',
      reason: resolved
        ? 'Mutasi dan jurnal sudah final.'
        : staleJournal
          ? 'Mutasi menunjuk jurnal yang tidak lagi tersedia.'
          : linkedJournalNotPosted
            ? `Mutasi menunjuk jurnal berstatus "${journal.status}", sehingga tidak boleh dianggap sudah terposting.`
            : 'Mutasi belum final dan aman dievaluasi ulang melalui matcher canonical.',
      records: [
        { table: 'public.bank_mutations', id: mutation.id, role: 'mutation' },
        ...(match ? [{ table: 'public.bank_reconciliation_matches', id: match.id, role: 'match' }] : []),
        ...(journal ? [{ table: 'public.accounting_entries', id: journal.id, role: 'journal' }] : []),
      ],
      sql: null,
      autoRepair: resolved || developerActionRequired ? null : { method: 'POST', path: '/api/bank-reconciliation/run-matching', label: 'Evaluasi ulang Rule AI' },
      verification: { before: { status: mutation.status, journalEntryId: mutation.journal_entry_id, journalStatus: journal?.status ?? null, matchStatus: match?.status ?? null }, after: null },
    };
    res.json({ ok: true, diagnosis });
  } finally { client.release(); }
});

router.all("/bank-reconciliation/unsupported-standalone-action", async (req, res): Promise<void> => {
  const actor = await getApprovalActor(req).catch(() => null);
  if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
  res.status(409).json({
    error: "Aksi legacy ini dinonaktifkan pada CST-BIZPORTAL standalone karena belum memiliki kontrak backend yang aman.",
    code: "UNSUPPORTED_STANDALONE_RECONCILIATION_ACTION",
  });
});

router.post("/bank-reconciliation/:mutationId/approve", async (req, res): Promise<void> => {
  const mutationId = parsePositiveInt(req.params.mutationId);
  if (mutationId === null) {
    res.status(400).json({ error: "ID mutasi tidak valid", code: "INVALID_MUTATION_ID" });
    return;
  }

  let actor: ApprovalActor | null;
  try {
    actor = await getApprovalActor(req);
  } catch (error) {
    req.log.error({ error }, "Failed to resolve approval actor");
    res.status(503).json({ error: "Authorization service unavailable" });
    return;
  }
  if (!actor) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const idempotencyKey = textValue(req.header("x-idempotency-key"));
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await approveBankMutation(
      client,
      mutationId,
      (req.body ?? {}) as ApprovalBody,
      actor,
      idempotencyKey,
    );
    await client.query("commit");
    res.json(result);
  } catch (error) {
    try {
      await client.query("rollback");
    } catch (rollbackError) {
      req.log.warn({ rollbackError }, "Bank reconciliation approval rollback failed");
    }

    if (error instanceof ApprovalError) {
      res.status(error.status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...([
          "JOURNAL_MAPPING_REQUIRED",
          "COA_NOT_FOUND",
          "SOURCE_JOURNAL_REQUIRED",
          "SOURCE_RECEIPT_ACCOUNT_UNRESOLVED",
          "SOURCE_OWNED_COA_OVERRIDE_BLOCKED",
          "SOURCE_PAYMENT_BANK_UNRESOLVED",
          "SOURCE_JOURNAL_BANK_MISMATCH",
        ].includes(error.code ?? "")
          ? { manual_review_required: true }
          : {}),
      });
      return;
    }

    if ((error as { code?: string }).code === "42P01") {
      req.log.error({ error, mutationId }, "Bank reconciliation schema is unavailable");
      res.status(503).json({
        error: "Schema bank reconciliation belum tersedia pada database lokal.",
        code: "BANK_RECONCILIATION_SCHEMA_UNAVAILABLE",
      });
      return;
    }

    const dbError = error as { code?: string; message?: string; detail?: string; constraint?: string };
    req.log.error({ error, mutationId }, "Bank reconciliation approval failed");
    const knownDatabaseCodes = new Set(["23503", "23505", "23514", "22P02", "P0001"]);
    if (dbError.code && knownDatabaseCodes.has(dbError.code)) {
      res.status(409).json({
        error: dbError.message ?? "Draft jurnal ditolak oleh validasi database.",
        code: "ACCOUNTING_VALIDATION_FAILED",
        detail: dbError.detail ?? null,
        constraint: dbError.constraint ?? null,
      });
      return;
    }
    res.status(503).json({
      error: dbError.message ?? "Approval mutasi dan pembuatan draft jurnal gagal",
      code: dbError.code ?? "BANK_RECONCILIATION_APPROVAL_FAILED",
    });
  } finally {
    client.release();
  }
});

router.post("/bank-reconciliation/:mutationId/unmatch", async (req, res): Promise<void> => {
  const mutationId = parsePositiveInt(req.params.mutationId);
  if (mutationId === null) {
    res.status(400).json({ error: "ID mutasi tidak valid", code: "INVALID_MUTATION_ID" });
    return;
  }

  let actor: ApprovalActor | null;
  try {
    actor = await getApprovalActor(req);
  } catch (error) {
    req.log.error({ error, mutationId }, "Failed to resolve unmatch actor");
    res.status(503).json({ error: "Authorization service unavailable" });
    return;
  }
  if (!actor) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const reason =
    typeof req.body?.reason === "string"
      ? req.body.reason.trim()
      : typeof req.body?.note === "string"
        ? req.body.note.trim()
        : "";
  const client = await pool.connect();

  try {
    await client.query("begin");
    const locked = await client.query<{
      id: number;
      status: string;
      journal_entry_id: number | null;
      journal_status: string | null;
    }>(
      `select bm.id,
              bm.status,
              bm.journal_entry_id,
              ae.status as journal_status
         from public.bank_mutations bm
         left join public.accounting_entries ae on ae.id = bm.journal_entry_id
        where bm.id = $1
        for update of bm`,
      [mutationId],
    );
    const mutation = locked.rows[0];
    if (!mutation) {
      const error = new Error("Mutasi tidak ditemukan") as Error & { code?: string };
      error.code = "NOT_FOUND";
      throw error;
    }

    const status = String(mutation.status ?? "").toLowerCase();
    const resettableStatuses = new Set([
      "unmatched",
      "matched",
      "manual_review",
      "duplicate_need_review",
      "approved_pending_posting",
      "approved",
    ]);
    if (!resettableStatuses.has(status)) {
      const message =
        status === "posted"
          ? "Mutasi sudah posted. Gunakan alur Unmatch & Reverse agar ledger tetap immutable."
          : `Mutasi berstatus '${mutation.status}' tidak dapat di-unmatch melalui alur ini.`;
      const error = new Error(message) as Error & { code?: string };
      error.code = "INVALID_STATUS";
      throw error;
    }
    if (
      (status === "approved_pending_posting" || status === "approved")
      && (mutation.journal_entry_id == null || String(mutation.journal_status ?? "").toLowerCase() !== "draft")
    ) {
      const error = new Error(
        "Approval hanya dapat dibatalkan bila jurnal terkait masih berstatus draft.",
      ) as Error & { code?: string };
      error.code = "JOURNAL_LINKED";
      throw error;
    }

    let removedDraftJournalId: number | null = null;
    if (mutation.journal_entry_id !== null) {
      const journalStatus = String(mutation.journal_status ?? "").toLowerCase();
      if (journalStatus === "draft") {
        // Release the FK before deleting the draft journal. Both statements run
        // in the same transaction, so any later failure restores the original
        // mutation-to-journal link and prevents a partially cancelled state.
        const unlinked = await client.query(
          `update public.bank_mutations
              set journal_entry_id = null,
                  updated_at = now()
            where id = $1
              and journal_entry_id = $2
          returning id`,
          [mutationId, mutation.journal_entry_id],
        );
        if (unlinked.rowCount !== 1) {
          const error = new Error(
            `Draft journal #${mutation.journal_entry_id} tidak dapat dibatalkan karena tautan mutasi berubah bersamaan.`,
          ) as Error & { code?: string };
          error.code = "JOURNAL_CONCURRENT_CHANGE";
          throw error;
        }

        const deleted = await client.query(
          `delete from public.accounting_entries
            where id = $1 and status = 'draft'`,
          [mutation.journal_entry_id],
        );
        if (deleted.rowCount !== 1) {
          const error = new Error(
            `Draft journal #${mutation.journal_entry_id} tidak dapat dibatalkan karena status berubah bersamaan.`,
          ) as Error & { code?: string };
          error.code = "JOURNAL_CONCURRENT_CHANGE";
          throw error;
        }
        removedDraftJournalId = mutation.journal_entry_id;
      } else if (journalStatus === "posted") {
        const error = new Error(
          "Journal sudah posted. Gunakan Unmatch & Reverse agar ledger tetap immutable.",
        ) as Error & { code?: string };
        error.code = "JOURNAL_POSTED";
        throw error;
      } else if (!journalStatus) {
        const error = new Error(
          `Journal entry #${mutation.journal_entry_id} tidak ditemukan. Periksa data jurnal sebelum unmatch.`,
        ) as Error & { code?: string };
        error.code = "JOURNAL_MISSING";
        throw error;
      } else {
        const error = new Error(
          `Journal entry #${mutation.journal_entry_id} berstatus '${journalStatus}' dan tidak dapat di-unmatch melalui alur ini.`,
        ) as Error & { code?: string };
        error.code = "JOURNAL_LINKED";
        throw error;
      }
    }

    await client.query(
      `delete from public.bank_reconciliation_matches
        where mutation_id = $1 and status in ('candidate', 'rejected')`,
      [mutationId],
    );
    const released = await client.query<{ id: number }>(
      `update public.bank_reconciliation_matches
          set status = 'superseded'
        where mutation_id = $1 and status = 'approved'
      returning id`,
      [mutationId],
    );
    const releasedMatchIds = released.rows.map((row) => row.id);

    const allocationGroups = await client.query<{ group_id: number | null }>(
      `select distinct group_id
         from public.payment_allocations
        where mutation_id = $1
          and coalesce(is_active, true) = true`,
      [mutationId],
    );
    await client.query(
      `update public.payment_allocations
          set is_active = false
        where mutation_id = $1
          and coalesce(is_active, true) = true`,
      [mutationId],
    );
    const groupIds = allocationGroups.rows
      .map((row) => row.group_id)
      .filter((id): id is number => Number.isInteger(id) && Number(id) > 0);
    if (groupIds.length > 0) {
      await client.query(
        `update public.payment_matching_groups
            set status = 'reversed', updated_at = now()
          where id = any($1::bigint[])
            and status = 'active'`,
        [groupIds],
      );
    }

    await client.query(
      `update public.bank_mutations
          set status = 'unmatched',
              journal_entry_id = null,
              matched_payment_id = null,
              matched_order_id = null,
              linked_transaction_type = null,
              linked_transaction_id = null,
              reconciliation_status = 'unmatched',
              approved_by = null,
              approved_at = null,
              updated_at = now()
        where id = $1`,
      [mutationId],
    );
    await client.query(
      `insert into public.bank_reconciliation_audit
        (mutation_id, action, actor, meta)
       values ($1, 'UNMATCHED', $2, $3::jsonb)`,
      [
        mutationId,
        actor.email,
        JSON.stringify({
          reason: reason || null,
          previous_status: mutation.status,
          removed_draft_journal_id: removedDraftJournalId,
          released_approved_match_ids: releasedMatchIds,
        }),
      ],
    );

    await client.query("commit");
    res.json({ ok: true, released_match_ids: releasedMatchIds });
  } catch (error) {
    try {
      await client.query("rollback");
    } catch (rollbackError) {
      req.log.warn({ rollbackError, mutationId }, "Unmatch rollback failed");
    }

    const code = (error as { code?: string }).code;
    const statusCode =
      code === "NOT_FOUND" ? 404 :
      code === "INVALID_STATUS" ||
      code === "JOURNAL_LINKED" ||
      code === "JOURNAL_POSTED" ||
      code === "JOURNAL_MISSING" ||
      code === "JOURNAL_CONCURRENT_CHANGE" ? 409 :
      503;
    req.log.error({ error, mutationId }, "Bank reconciliation unmatch failed");
    res.status(statusCode).json({
      error: error instanceof Error ? error.message : "Unmatch mutasi gagal",
    });
  } finally {
    client.release();
  }
});

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function queryString(value: unknown): string | null {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" ? value : null;
}

const MUTATION_STATUSES = new Set([
  "unmatched",
  "matched",
  "manual_review",
  "duplicate_need_review",
  "approved_pending_posting",
  "approved",
  "posted",
  "rejected",
  "void",
]);

function buildMutationFilters(req: Request): { where: string; values: unknown[]; companyId: number | null } {
  const values: unknown[] = [];
  const filters = ["true"];
  const rawCompanyId = queryString(req.query.company_id)
    ?? queryString(req.query.companyId)
    ?? queryString(req.query.company);
  const companyId = rawCompanyId === null || rawCompanyId === "" || rawCompanyId === "all"
    ? null
    : parsePositiveInt(rawCompanyId);

  if (rawCompanyId !== null && rawCompanyId !== "" && rawCompanyId !== "all" && companyId === null) {
    throw new Error("INVALID_COMPANY");
  }
  if (companyId !== null) {
    values.push(companyId);
    filters.push(`bm.company_id = $${values.length}`);
  }

  const status = queryString(req.query.status);
  if (status && status !== "all") {
    if (status === "completed") {
      // Keep this as a SQL literal list instead of binding a JavaScript array.
      // The Supabase pooler rejects the parameter cast used by `ANY($n::text[])`
      // for this route, which turns an otherwise valid completed filter into a
      // misleading 503 schema error.
      filters.push("bm.status in ('posted', 'approved')");
    } else {
      if (!MUTATION_STATUSES.has(status)) throw new Error("INVALID_STATUS");
      values.push(status);
      filters.push(`bm.status = $${values.length}`);
    }
  }

  const direction = queryString(req.query.direction);
  if (direction && direction !== "all") {
    const normalizedDirection = direction.toUpperCase();
    if (!["IN", "OUT"].includes(normalizedDirection)) throw new Error("INVALID_DIRECTION");
    values.push(normalizedDirection);
    filters.push(`bm.direction = $${values.length}`);
  }

  const provider = queryString(req.query.provider);
  if (provider && provider !== "all") {
    values.push(provider);
    filters.push(`bm.provider_name = $${values.length}`);
  }

  const paymentType = queryString(req.query.payment_type);
  if (paymentType && paymentType !== "all") {
    if (!["bank_transfer", "qris", "paylabs"].includes(paymentType)) {
      throw new Error("INVALID_PAYMENT_TYPE");
    }
    const compactEvidence = `
      upper(regexp_replace(
        concat_ws(' ', bm.provider_name, bm.provider_order_id, bm.description, bm.normalized_description),
        '[^A-Za-z0-9]', '', 'g'
      ))
    `;
    if (paymentType === "bank_transfer") {
      filters.push(`(
        ${compactEvidence} not like '%QRIS%'
        and ${compactEvidence} not like '%PAYLABS%'
        and ${compactEvidence} not like '%QRTRAVELI%'
        or ${compactEvidence} like '%INHOUSETRF%'
      )`);
    } else if (paymentType === "paylabs") {
      filters.push(`lower(concat_ws(' ', bm.provider_name, bm.provider_order_id, bm.description, bm.normalized_description)) like '%paylabs%'`);
    } else {
      filters.push(`(
        ${compactEvidence} like '%QRIS%'
        or ${compactEvidence} like '%QRTRAVELI%'
        or lower(concat_ws(' ', bm.provider_name, bm.provider_order_id, bm.description, bm.normalized_description)) like '%paylabs%'
        or concat_ws(' ', bm.provider_name, bm.provider_order_id, bm.description, bm.normalized_description) ~* 'QR[A-Z0-9]{4,}'
        or concat_ws(' ', bm.provider_name, bm.provider_order_id, bm.description, bm.normalized_description) ~* '\\mQR\\s*(CODE|PAY|PAYMENT)\\M'
      )`);
    }
  }

  const bankAccountId = queryString(req.query.bank_account_id);
  if (bankAccountId && bankAccountId !== "all") {
    values.push(bankAccountId);
    filters.push(`bm.bank_account_id::text = $${values.length}`);
  }

  const from = queryString(req.query.from);
  if (from) {
    values.push(from);
    filters.push(`bm.transaction_date >= $${values.length}::date`);
  }

  const to = queryString(req.query.to);
  if (to) {
    values.push(to);
    filters.push(`bm.transaction_date <= $${values.length}::date`);
  }

  const search = queryString(req.query.search)?.trim();
  if (search) {
    values.push(`%${search}%`);
    const placeholder = `$${values.length}`;
    filters.push(`(
      bm.description ilike ${placeholder}
      or bm.mutation_key ilike ${placeholder}
      or coalesce(bm.provider_order_id, '') ilike ${placeholder}
      or coalesce(bm.source_account, '') ilike ${placeholder}
    )`);
  }

  return { where: filters.join(" and "), values, companyId };
}

const mutationListColumns = `
  bm.id,
  bm.company_id,
  bm.transaction_date,
  bm.description,
  bm.credit_amount,
  bm.debit_amount,
  bm.amount,
  upper(bm.direction) as direction,
  bm.mutation_key,
  bm.normalized_description,
  bm.provider_name,
  bm.provider_order_id,
  bm.status,
  bm.matched_payment_id,
  bm.matched_order_id,
  bm.uploaded_proof_url,
  bm.source,
  bm.import_batch_id,
  bm.reconciliation_status,
  bm.linked_transaction_type,
  bm.linked_transaction_id,
  bm.journal_entry_id,
  coalesce(
    (
      select entry.status::text
        from public.accounting_entries entry
       where entry.id = bm.journal_entry_id
         and entry.company_id = bm.company_id
       limit 1
    ),
    (
      select settlement_journal.status::text
        from public.bank_reconciliation_matches settlement_match
        join sport_center.payment_settlement_batches settlement_batch
          on settlement_match.candidate_type = 'qris_settlement'
         and settlement_match.candidate_source = 'sport_center.payment_settlement_batches'
         and settlement_batch.id = settlement_match.candidate_id
        join sport_center.accounting_journals settlement_journal
          on settlement_journal.id = settlement_batch.settlement_journal_id
       where settlement_match.mutation_id = bm.id
         and settlement_match.status in ('approved','posted','reconciled')
         and settlement_journal.status::text = 'posted'
       order by settlement_match.id desc
       limit 1
    )
  ) as journal_status,
  (
    select coalesce(
      json_agg(
        json_build_object(
          'code', posted_line.code,
          'name', posted_line.name,
          'debit', posted_line.debit,
          'credit', posted_line.credit
        )
        order by posted_line.sort_group, posted_line.sort_id
      ),
      '[]'::json
    )
    from (
      select
        coa.code,
        coa.name,
        line.debit,
        line.credit,
        0 as sort_group,
        line.id as sort_id
      from public.accounting_entry_lines line
      join public.accounting_entries entry
        on entry.id = line.entry_id
      left join public.chart_of_accounts coa
        on coa.id = line.account_id
      where line.entry_id = bm.journal_entry_id
        and entry.company_id = bm.company_id
        and entry.status = 'posted'

      union all

      select
        case
          when settlement_line.account_code = '1199'
           and lower(trim(coalesce(settlement_line.account_name, ''))) = 'payment clearing'
            then coalesce(canonical_clearing.code, settlement_line.account_code)
          else settlement_line.account_code
        end as code,
        case
          when settlement_line.account_code = '1199'
           and lower(trim(coalesce(settlement_line.account_name, ''))) = 'payment clearing'
            then coalesce(canonical_clearing.name, settlement_line.account_name)
          else settlement_line.account_name
        end as name,
        case when lower(settlement_line.line_type::text) = 'debit'
          then settlement_line.amount else 0 end as debit,
        case when lower(settlement_line.line_type::text) = 'credit'
          then settlement_line.amount else 0 end as credit,
        1 as sort_group,
        settlement_line.id as sort_id
      from public.bank_reconciliation_matches settlement_match
      join sport_center.payment_settlement_batches settlement_batch
        on settlement_match.candidate_type = 'qris_settlement'
       and settlement_match.candidate_source = 'sport_center.payment_settlement_batches'
       and settlement_batch.id = settlement_match.candidate_id
      join sport_center.accounting_journals settlement_journal
        on settlement_journal.id = settlement_batch.settlement_journal_id
       and settlement_journal.status::text = 'posted'
      join sport_center.accounting_journal_lines settlement_line
        on settlement_line.journal_id = settlement_journal.id
      left join lateral (
        select clearing_coa.code, clearing_coa.name
        from public.chart_of_accounts clearing_coa
        where clearing_coa.company_id = bm.company_id
          and clearing_coa.code like '1-1024-%'
          and clearing_coa.name ilike 'Payment Clearing Sport Center / QRIS%'
          and clearing_coa.account_category = 'ASSET'
          and clearing_coa.is_active = true
          and coalesce(clearing_coa.is_header, false) = false
          and coalesce(clearing_coa.is_postable, true) = true
        order by clearing_coa.id
        limit 1
      ) canonical_clearing on true
      where bm.journal_entry_id is null
        and settlement_match.mutation_id = bm.id
        and settlement_match.status in ('approved','posted','reconciled')
        and settlement_batch.company_id = bm.company_id
        and settlement_batch.status::text in ('reconciled','settled','completed')
        and coalesce(
          settlement_batch.canonical_bank_mutation_id,
          settlement_batch.bank_mutation_id
        ) = bm.id
    ) posted_line
  ) as posted_coa_accounts,
  (
    select coalesce(
      json_agg(
        json_build_object(
          'code', source_coa.code,
          'name', source_coa.name,
          'debit', source_line.debit,
          'credit', source_line.credit
        )
        order by source_line.id
      ),
      '[]'::json
    )
      from public.accounting_entry_lines source_line
      join public.accounting_entries source_entry
        on source_entry.id = source_line.entry_id
      left join public.chart_of_accounts source_coa
        on source_coa.id = source_line.account_id
     where source_line.entry_id = (
       select candidate_entry.id
         from public.accounting_entries candidate_entry
        where candidate_entry.company_id = bm.company_id
          and candidate_entry.status = 'posted'
          and abs(candidate_entry.total_debit::numeric - bm.amount::numeric) < 0.01
          and (
            (
              bm.linked_transaction_type = 'sport_payment'
              and (
                candidate_entry.source_payment_id = bm.linked_transaction_id
                or (
                  candidate_entry.source::text in ('sport_center_payment','sport_center_booking','sport_center_membership')
                  and candidate_entry.source_id = bm.linked_transaction_id
                )
              )
            )
            or (
              bm.linked_transaction_type = 'tenant_invoice'
              and candidate_entry.source::text = 'tenant_rent_payment'
              and candidate_entry.source_id in (
                bm.linked_transaction_id,
                coalesce(
                  (
                    select nullif(to_jsonb(tp)->>'duplicate_of_payment_id', '')::integer
                      from public.tenant_payments tp
                     where tp.id = bm.linked_transaction_id
                       and tp.company_id = bm.company_id
                     limit 1
                  ),
                  bm.linked_transaction_id
                )
              )
            )
          )
        order by
          case
            when bm.linked_transaction_type = 'sport_payment'
             and candidate_entry.source_payment_id = bm.linked_transaction_id then 0
            when bm.linked_transaction_type = 'tenant_invoice'
             and candidate_entry.source_id = bm.linked_transaction_id then 0
            else 1
          end,
          candidate_entry.id desc
        limit 1
     )
       and source_entry.company_id = bm.company_id
       and source_entry.status = 'posted'
  ) as source_posted_coa_accounts,
  (
    select coalesce(
      json_agg(
        json_build_object(
          'code', correction_coa.code,
          'name', correction_coa.name,
          'debit', correction_line.debit,
          'credit', correction_line.credit
        )
        order by correction_entry.id, correction_line.id
      ),
      '[]'::json
    )
      from public.accounting_entries correction_entry
      join public.accounting_entry_lines correction_line
        on correction_line.entry_id = correction_entry.id
      left join public.chart_of_accounts correction_coa
        on correction_coa.id = correction_line.account_id
     where bm.linked_transaction_type = 'sport_payment'
       and correction_entry.company_id = bm.company_id
       and correction_entry.status = 'posted'
       and correction_entry.source::text = 'sport_center_ppn_correction'
       and correction_entry.source_id = (
         select sp.booking_id
           from sport_center.sport_payments sp
          where sp.id = bm.linked_transaction_id
          limit 1
       )
  ) as source_correction_coa_accounts,
  (
    select coalesce(json_agg(json_build_object(
      'id', match.id,
      'mutation_id', match.mutation_id,
      'candidate_type', match.candidate_type,
      'candidate_id', match.candidate_id,
      'candidate_source', match.candidate_source,
      'match_score', match.match_score,
      'match_reason', match.match_reason,
      'amount_match', match.amount_match,
      'date_match', match.date_match,
      'name_match', match.name_match,
      'order_id_match', match.order_id_match,
      'proof_match', match.proof_match,
      'status', match.status,
      'customer_name', match.customer_name,
       'order_ref', match.order_ref,
       'details', null
    ) order by match.match_score desc nulls last, match.id), '[]'::json)
    from public.bank_reconciliation_matches match
    where match.mutation_id = bm.id
      and match.candidate_source is not null
      and (
        (match.candidate_type = 'sport_payment' and match.candidate_source = 'sport_center.sport_payments')
        or (match.candidate_type = 'sport_company_invoice' and match.candidate_source = 'sport_center.company_invoices')
        or (match.candidate_type = 'tenant_invoice' and match.candidate_source = 'public.tenant_payments')
        or (match.candidate_type = 'vendor_invoice' and match.candidate_source = 'public.vendor_invoices')
        or (match.candidate_type = 'qris_settlement' and match.candidate_source = 'sport_center.payment_settlement_batches')
        or (match.candidate_type = 'recon_rule' and match.candidate_source = 'public.recon_rules')
      )
  ) as candidates,
  exists (
    select 1
    from public.bank_reconciliation_matches approved_match
    where approved_match.mutation_id = bm.id
      and approved_match.status = 'approved'
  ) as has_approved_match,
  '[]'::json as qris_candidate_audits,
  null::json as qris_candidate_audit
`;

type MutationCandidateRow = {
  candidates?: Array<Record<string, unknown>> | null;
  [key: string]: unknown;
};

function candidateDetailKey(candidateType: unknown, candidateId: unknown): string {
  return `${String(candidateType ?? "")}:${String(candidateId ?? "")}`;
}

async function hydrateMutationCandidateDetails(rows: MutationCandidateRow[]): Promise<void> {
  const candidateIds = new Map<string, number[]>();
  for (const row of rows) {
    for (const candidate of Array.isArray(row.candidates) ? row.candidates : []) {
      const candidateType = String(candidate.candidate_type ?? "");
      const candidateId = Number(candidate.candidate_id);
      if (!Number.isSafeInteger(candidateId) || candidateId <= 0) continue;
      const ids = candidateIds.get(candidateType) ?? [];
      ids.push(candidateId);
      candidateIds.set(candidateType, ids);
    }
  }

  const details = new Map<string, Record<string, unknown>>();
  const idsFor = (candidateType: string): number[] =>
    [...new Set(candidateIds.get(candidateType) ?? [])];

  const sportIds = idsFor("sport_payment");
  if (sportIds.length > 0) {
    try {
      const result = await pool.query<Record<string, unknown>>(
        `select sp.id,
                sp.amount,
                (coalesce(sp.paid_at, sp.created_at) at time zone 'Asia/Jakarta')::date::text as date,
                coalesce(
                  nullif(to_jsonb(sp)->>'payment_number', ''),
                  nullif(to_jsonb(sp)->>'provider_order_id', ''),
                  nullif(to_jsonb(sp)->>'provider_id', '')
                ) as reference,
                concat_ws(
                  ' ',
                  nullif(to_jsonb(sb)->>'customer_name', ''),
                  nullif(to_jsonb(sp)->>'payment_type', ''),
                  nullif(to_jsonb(sp)->>'payment_provider', ''),
                  nullif(to_jsonb(sp)->>'provider_order_id', '')
                ) as name,
                coalesce(to_jsonb(sp)->>'payment_method', to_jsonb(sp)->>'method') as method,
                to_jsonb(sp)->>'payment_type' as payment_type,
                to_jsonb(sp)->>'payment_provider' as payment_provider,
                sp.status::text as status,
                sp.booking_id
           from sport_center.sport_payments sp
           left join sport_center.sport_bookings sb on sb.id = sp.booking_id
          where sp.id = any($1::bigint[])`,
        [sportIds],
      );
      for (const row of result.rows) {
        const method = String(row.method ?? "").toLowerCase();
        const provider = String(row.payment_provider ?? "").toLowerCase();
        const paymentType = String(row.payment_type ?? "").toLowerCase();
        const sportPaymentType =
          provider.includes("paylabs") ? "paylabs" :
          method.includes("qris") || paymentType.includes("qris") ? "qris" :
          "bank_transfer";
        details.set(candidateDetailKey("sport_payment", row.id), {
          amount: row.amount,
          date: row.date,
          name: row.name,
          reference: row.reference,
          method: row.method,
          paymentMethod: row.method,
          paymentType: row.payment_type,
          paymentProvider: row.payment_provider,
          sportPaymentType,
          sourceType: "sport_payment",
          status: row.status,
          bookingId: row.booking_id,
        });
      }
    } catch {
      // The Sport Center schema is optional for bank-only installations.
    }
  }

  const sportCompanyInvoiceIds = idsFor("sport_company_invoice");
  if (sportCompanyInvoiceIds.length > 0) {
    try {
      const result = await pool.query<Record<string, unknown>>(
        `select
             ci.id,
             coalesce(
               nullif(ci.net_amount::numeric, 0),
               nullif(ci.paid_amount::numeric, 0),
               ci.grand_total::numeric
             ) as amount,
             (ci.paid_at at time zone 'Asia/Jakarta')::date::text as date,
             ci.invoice_number as reference,
             customer.name,
             ci.payment_method as method,
             coalesce(nullif(ci.invoice_status, ''), ci.status) as status,
             ci.payment_proof_url as proof_url,
             count(cii.id)::int as booking_count,
             array_remove(array_agg(distinct nullif(btrim(sb.group_ref::text), '')), null) as group_refs
          from sport_center.company_invoices ci
          left join sport_center.users customer on customer.id = ci.company_customer_id
          left join sport_center.company_invoice_items cii on cii.invoice_id = ci.id
          left join sport_center.sport_bookings sb on sb.id = cii.booking_id
         where ci.id = any($1::bigint[])
         group by ci.id, customer.name`,
        [sportCompanyInvoiceIds],
      );
      for (const row of result.rows) {
        details.set(candidateDetailKey("sport_company_invoice", row.id), {
          amount: row.amount,
          date: row.date,
          name: row.name,
          reference: row.reference,
          method: row.method,
          paymentMethod: row.method,
          sourceType: "sport_company_invoice",
          status: row.status,
          proofUrl: row.proof_url,
          bookingCount: row.booking_count,
          groupRefs: row.group_refs,
        });
      }
    } catch {
      // Corporate invoice details are additive to the core reconciliation response.
    }
  }

  const tenantIds = idsFor("tenant_invoice");
  if (tenantIds.length > 0) {
    try {
      const result = await pool.query<Record<string, unknown>>(
        `select tp.id,
                tp.amount,
                coalesce(
                  (tp.paid_at at time zone 'Asia/Jakarta')::date,
                  (tp.created_at at time zone 'Asia/Jakarta')::date
                )::text as date,
                tp.payment_number as reference,
                t.business_name as name,
                tp.method,
                tp.status::text as status,
                tp.tenant_booking_id as booking_id
           from public.tenant_payments tp
           left join public.tenant_bookings tb on tb.id = tp.tenant_booking_id
           left join public.tenants t on t.id = coalesce(tp.tenant_id, tb.tenant_id)
          where tp.id = any($1::bigint[])`,
        [tenantIds],
      );
      for (const row of result.rows) {
        details.set(candidateDetailKey("tenant_invoice", row.id), {
          amount: row.amount,
          date: row.date,
          name: row.name,
          reference: row.reference,
          paymentNumber: row.reference,
          method: row.method,
          paymentMethod: row.method,
          sourceType: "tenant_payment",
          status: row.status,
          bookingId: row.booking_id,
        });
      }
    } catch {
      // Tenant is optional and should not make the mutation list unavailable.
    }
  }

  const invoiceIds = idsFor("vendor_invoice");
  if (invoiceIds.length > 0) {
    try {
      const result = await pool.query<Record<string, unknown>>(
        `select id, grand_total as amount, due_date::text as date,
                supplier_name as name, invoice_number as reference,
                vendor_invoice_ref as memo, status::text as status
           from public.vendor_invoices
          where id = any($1::bigint[])`,
        [invoiceIds],
      );
      for (const row of result.rows) {
        details.set(candidateDetailKey("vendor_invoice", row.id), {
          amount: row.amount,
          date: row.date,
          name: row.name,
          reference: row.reference,
          memo: row.memo,
          documentType: "vendor_invoice",
          status: row.status,
        });
      }
    } catch {
      // Vendor invoice details are additive to the core match response.
    }
  }

  const qrisSettlementIds = idsFor("qris_settlement");
  if (qrisSettlementIds.length > 0) {
    try {
      const result = await pool.query<Record<string, unknown>>(
        `select
           psb.id,
           psb.gross_amount,
           psb.mdr_amount,
           psb.provider_fee_amount,
           psb.fee_tax_amount,
           psb.tax_withheld_amount,
           psb.adjustment_amount,
           psb.net_amount,
           psb.settlement_date::text as settlement_date,
           psb.settlement_reference,
           psb.status::text as settlement_status,
           psb.settlement_journal_id,
           psb.bank_mutation_id,
           psb.canonical_bank_mutation_id,
           psb.settlement_rule_version,
           (
             select sj.status::text
               from sport_center.accounting_journals sj
              where sj.id = psb.settlement_journal_id
              limit 1
           ) as settlement_journal_status,
           (
             select count(*)::int
               from sport_center.payment_settlement_items psi
              where psi.settlement_id = psb.id
                and psi.item_status = 'active'
           ) as settlement_item_count,
           coalesce((
             select json_agg(
               json_build_object(
                 'id', psi.id,
                 'sportPaymentId', psi.payment_id,
                 'paymentNumber', coalesce(
                   nullif(to_jsonb(sp)->>'payment_number', ''),
                   nullif(sp.reference_number, ''),
                   nullif(sp.provider_order_id, '')
                 ),
                 'bookingId', sp.booking_id,
                 'grossAmount', psi.gross_amount,
                 'mdrAmount', sp.mdr_amount,
                 'netAmount', sp.net_amount
               )
               order by psi.id
             )
               from sport_center.payment_settlement_items psi
               left join sport_center.sport_payments sp on sp.id = psi.payment_id
              where psi.settlement_id = psb.id
                and psi.item_status = 'active'
           ), '[]'::json) as settlement_items,
           coalesce((
             select json_agg(
               json_build_object(
                 'id', line.id,
                 'lineType', line.line_type,
                 'accountCode', line.account_code,
                 'accountName', line.account_name,
                 'amount', line.amount,
                 'description', line.description
               )
               order by line.id
             )
               from sport_center.accounting_journal_lines line
              where line.journal_id = psb.settlement_journal_id
           ), '[]'::json) as settlement_journal_lines
         from sport_center.payment_settlement_batches psb
        where psb.id = any($1::bigint[])`,
        [qrisSettlementIds],
      );
      for (const row of result.rows) {
        const providerFees =
          Number(row.provider_fee_amount ?? 0) + Number(row.fee_tax_amount ?? 0);
        details.set(candidateDetailKey("qris_settlement", row.id), {
          amount: row.net_amount,
          date: row.settlement_date,
          reference: row.settlement_reference,
          status: row.settlement_status,
          sourceType: "sport_center",
          sportPaymentType: "qris",
          grossAmount: row.gross_amount,
          mdrAmount: row.mdr_amount,
          taxWithheldAmount: row.tax_withheld_amount,
          otherFeeAmount: providerFees,
          netAmount: row.net_amount,
          settlementDate: row.settlement_date,
          settlementReference: row.settlement_reference,
          settlementStatus: row.settlement_status,
          settlementItemCount: row.settlement_item_count,
          settlementJournalId: row.settlement_journal_id,
          settlementJournalStatus: row.settlement_journal_status,
          bankMutationId: row.bank_mutation_id,
          canonicalBankMutationId: row.canonical_bank_mutation_id,
          expectedAmount: row.net_amount,
          settlementRuleVersion: row.settlement_rule_version,
          settlementItems: row.settlement_items,
          settlementJournalLines: row.settlement_journal_lines,
        });
      }
    } catch {
      // Canonical QRIS settlement details are additive. Keep the mutation
      // list usable on installations that do not have the Sport Center schema.
    }
  }

  for (const row of rows) {
    for (const candidate of Array.isArray(row.candidates) ? row.candidates : []) {
      candidate.details = details.get(
        candidateDetailKey(candidate.candidate_type, candidate.candidate_id),
      ) ?? null;
    }
  }
}

const qrisCandidateColumns = `
  qris.id,
  qris.mutation_id,
  qris.company_id,
  qris.provider_code,
  qris.mutation_source_classification,
  qris.source_date,
  qris.estimated_settlement_date,
  qris.gross_amount,
  qris.net_amount,
  qris.observed_deduction,
  qris.effective_deduction_rate,
  qris.reconciliation_status,
  qris.confidence,
  qris.review_reason,
  qris.payment_items,
  qris.candidate_source,
  qris.status,
  qris.auto_post_status,
  qris.auto_post_stage,
  qris.auto_post_problem,
  qris.auto_post_revision,
  qris.auto_post_action,
  qris.auto_post_details,
  qris.generated_at,
  qris.updated_at
`;

function qrisCandidateResponse(row: Record<string, unknown>): Record<string, unknown> {
  const paymentItems = Array.isArray(row.payment_items) ? row.payment_items : [];
  const paymentIds = paymentItems
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const value = item as Record<string, unknown>;
      const id = Number(value.paymentId ?? value.payment_id);
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    })
    .filter((id): id is number => id != null);

  return {
    ...row,
    payment_items: paymentItems,
    current_payment_ids: paymentIds,
    current_payment_amounts: Object.fromEntries(
      paymentItems.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const value = item as Record<string, unknown>;
        const id = Number(value.paymentId ?? value.payment_id);
        const amount = value.grossAmount ?? value.gross_amount;
        return Number.isSafeInteger(id) && id > 0 && amount != null
          ? [[String(id), amount]]
          : [];
      }),
    ),
  };
}

async function resolveCanonicalQrisSettlement(
  client: ApprovalClient,
  companyId: number,
  paymentIds: number[],
): Promise<number> {
  const normalizedPaymentIds = [...new Set(paymentIds)]
    .filter((paymentId) => Number.isSafeInteger(paymentId) && paymentId > 0)
    .sort((left, right) => left - right);

  if (normalizedPaymentIds.length === 0) {
    throw new ApprovalError(
      "Kandidat lokal QRIS tidak memiliki payment scope yang valid.",
      422,
      "INVALID_PAYMENT_SCOPE",
    );
  }

  // Resolve the complete payment scope directly against the canonical Sport
  // Center settlement contract. Requiring the full scope prevents partial or
  // ambiguous approval through the generic bank journal path.
  const result = await client.query<{ id: number | string }>(
    `with matching_batches as (
       select psb.id
         from sport_center.payment_settlement_batches psb
         join sport_center.payment_settlement_items psi
           on psi.settlement_id = psb.id
        where psb.company_id = $1
          and lower(coalesce(psb.status::text, '')) in ('posted', 'reconciled')
          and psi.item_status = 'active'
        group by psb.id
       having count(distinct psi.payment_id) = cardinality($2::bigint[])
          and count(distinct psi.payment_id) filter (
            where psi.payment_id = any($2::bigint[])
          ) = cardinality($2::bigint[])
     )
     select psb.id::bigint as id
       from sport_center.payment_settlement_batches psb
       join matching_batches mb on mb.id = psb.id
      where psb.company_id = $1
      for update of psb`,
    [companyId, normalizedPaymentIds],
  );
  if (result.rows.length === 0) {
    throw new ApprovalError(
      "Settlement canonical belum tersedia untuk seluruh payment scope kandidat QRIS.",
      409,
      "CANONICAL_SETTLEMENT_REQUIRED",
    );
  }
  if (result.rows.length > 1) {
    throw new ApprovalError(
      "Kandidat lokal QRIS memiliki lebih dari satu settlement canonical untuk payment scope yang sama. Selesaikan duplikasi settlement sebelum approval.",
      409,
      "CANONICAL_SETTLEMENT_SELECTION_CONFLICT",
    );
  }

  const settlementId = safeInteger(result.rows[0]?.id);
  if (settlementId === null) {
    throw new ApprovalError(
      "ID settlement canonical tidak valid; approval QRIS diblokir.",
      409,
      "CANONICAL_SETTLEMENT_REQUIRED",
    );
  }

  return settlementId;
}

async function ensureCanonicalQrisSettlement(
  client: ApprovalClient,
  companyId: number,
  paymentIds: number[],
  mutationDateValue: unknown,
  actor: string,
): Promise<number> {
  const normalizedPaymentIds = [...new Set(paymentIds)]
    .filter((paymentId) => Number.isSafeInteger(paymentId) && paymentId > 0)
    .sort((left, right) => left - right);
  const mutationDate = calendarDateValue(mutationDateValue);
  if (normalizedPaymentIds.length === 0 || !mutationDate) {
    throw new ApprovalError(
      "Scope payment atau tanggal mutasi QRIS tidak valid.",
      422,
      "INVALID_PAYMENT_SCOPE",
    );
  }

  // A retry after the owner function committed must reuse the same batch.
  try {
    return await resolveCanonicalQrisSettlement(client, companyId, normalizedPaymentIds);
  } catch (error) {
    if (!(error instanceof ApprovalError) || error.code !== "CANONICAL_SETTLEMENT_REQUIRED") {
      throw error;
    }
  }

  type PaymentRow = {
    id: number;
    amount: string | number | null;
    company_id: number | null;
    payment_method: string | null;
    provider_code: string | null;
    bank_account_id: string | null;
    expected_settlement_date: string | null;
    settlement_rule_version: string | null;
    settlement_status: string | null;
    payment_status: string | null;
  };
  const paymentResult = await client.query<PaymentRow>(
    `select p.id,
            p.amount,
            p.company_id,
            p.payment_method::text as payment_method,
            lower(btrim(p.payment_provider::text)) as provider_code,
            p.bank_account_id::text as bank_account_id,
            p.expected_settlement_date::text as expected_settlement_date,
            p.settlement_rule_version,
            p.settlement_status::text as settlement_status,
            p.status::text as payment_status
       from sport_center.sport_payments p
      where p.id = any($1::int[])
      for update`,
    [normalizedPaymentIds],
  );
  const payments = [...paymentResult.rows].sort((left, right) => left.id - right.id);
  if (payments.length !== normalizedPaymentIds.length) {
    throw new ApprovalError(
      "Satu atau lebih payment QRIS tidak ditemukan pada source canonical.",
      409,
      "CANONICAL_PAYMENT_NOT_FOUND",
    );
  }

  const source = payments[0]!;
  const groupDate = calendarDateValue(source.expected_settlement_date);
  const providerCode = String(source.provider_code ?? "").trim().toLowerCase();
  const bankAccountId = String(source.bank_account_id ?? "").trim();
  const ruleVersion = String(source.settlement_rule_version ?? "").trim();
  if (
    source.company_id !== companyId
    || !providerCode
    || !bankAccountId
    || !groupDate
    || !ruleVersion
    || groupDate !== mutationDate
    || payments.some((payment) =>
      payment.company_id !== companyId
      || !String(payment.payment_method ?? "").toLowerCase().includes("qris")
      || String(payment.provider_code ?? "").trim().toLowerCase() !== providerCode
      || String(payment.bank_account_id ?? "").trim() !== bankAccountId
      || calendarDateValue(payment.expected_settlement_date) !== groupDate
      || String(payment.settlement_rule_version ?? "").trim() !== ruleVersion
      || String(payment.payment_status ?? "").toLowerCase() !== "confirmed"
      || String(payment.settlement_status ?? "unsettled").toLowerCase() !== "unsettled",
    )
  ) {
    throw new ApprovalError(
      "Payment QRIS belum memenuhi satu group settlement canonical yang konsisten.",
      409,
      "CANONICAL_SETTLEMENT_GROUP_INVALID",
    );
  }

  const journalResult = await client.query<{
    payment_id: number;
    id: number;
    status: string;
    effective_gross_amount: string | number | null;
    base_debit_amount: string | number | null;
    base_credit_amount: string | number | null;
    correction_count: string | number | null;
  }>(
    `select j.payment_id,
            j.id,
            j.status,
            j.gross_amount + coalesce((
              select sum(case when correction.is_reversal
                              then -correction.gross_amount
                              else correction.gross_amount
                         end)
                from sport_center.accounting_journals correction
               where correction.payment_id = j.payment_id
                 and correction.journal_type = 'payment_amount_correction'
                 and correction.status = 'posted'
                 and correction.reversal_of_id = j.id
            ), 0) as effective_gross_amount,
            coalesce((
              select sum(line.amount)
                from sport_center.accounting_journal_lines line
               where line.journal_id = j.id
                 and lower(line.line_type) = 'debit'
            ), 0) as base_debit_amount,
            coalesce((
              select sum(line.amount)
                from sport_center.accounting_journal_lines line
               where line.journal_id = j.id
                 and lower(line.line_type) = 'credit'
            ), 0) as base_credit_amount,
            (
              select count(*)
                from sport_center.accounting_journals correction
               where correction.payment_id = j.payment_id
                 and correction.journal_type = 'payment_amount_correction'
                 and correction.status = 'posted'
                 and correction.reversal_of_id = j.id
            ) as correction_count
       from sport_center.accounting_journals j
      where j.payment_id = any($1::int[])
        and j.journal_type = 'payment_confirmed'
        and j.is_reversal = false
      order by j.payment_id, j.id
      for update`,
    [normalizedPaymentIds],
  );
  const journalByPayment = new Map<number, {
    id: number;
    status: string;
    effective_gross_amount: string | number | null;
    base_debit_amount: string | number | null;
    base_credit_amount: string | number | null;
    correction_count: string | number | null;
  }>();
  for (const journal of journalResult.rows) {
    const existing = journalByPayment.get(journal.payment_id);
    if (existing) {
      const existingPosted = existing.status === "posted";
      const incomingPosted = journal.status === "posted";
      if (existingPosted !== incomingPosted) {
        if (incomingPosted) journalByPayment.set(journal.payment_id, journal);
        continue;
      }
      throw new ApprovalError(
        `Payment ${journal.payment_id} memiliki lebih dari satu jurnal payment_confirmed dengan status finansial yang sama.`,
        409,
        "CANONICAL_PAYMENT_JOURNAL_AMBIGUOUS",
      );
    }
    journalByPayment.set(journal.payment_id, journal);
  }
  if (
    normalizedPaymentIds.some((paymentId) =>
      journalByPayment.get(paymentId)?.status !== "posted",
    )
  ) {
    throw new ApprovalError(
      "Semua payment QRIS harus memiliki payment_confirmed journal yang sudah posted sebelum settlement dibuat.",
      409,
      "CANONICAL_PAYMENT_JOURNAL_NOT_POSTED",
    );
  }
  for (const payment of payments) {
    const journal = journalByPayment.get(payment.id);
    const journalGross = Number(journal?.effective_gross_amount);
    const paymentGross = Number(payment.amount);
    const baseDebit = Number(journal?.base_debit_amount);
    const baseCredit = Number(journal?.base_credit_amount);
    const correctionCount = Number(journal?.correction_count ?? 0);
    const postedLinesProveGross =
      correctionCount === 0
      && Number.isFinite(baseDebit)
      && Number.isFinite(baseCredit)
      && Math.abs(baseDebit - baseCredit) <= 0.01
      && Math.abs(baseDebit - paymentGross) <= 0.01;

    if (
      !Number.isFinite(journalGross)
      || !Number.isFinite(paymentGross)
      || (Math.abs(journalGross - paymentGross) > 0.01 && !postedLinesProveGross)
    ) {
      const difference = Number.isFinite(journalGross) && Number.isFinite(paymentGross)
        ? paymentGross - journalGross
        : null;
      throw new ApprovalError(
        `Gross payment ${payment.id} berbeda dengan gross jurnal payment: source ${Number.isFinite(paymentGross) ? paymentGross : "tidak valid"}, jurnal efektif ${Number.isFinite(journalGross) ? journalGross : "tidak tersedia"}, selisih ${difference == null ? "tidak dapat dihitung" : difference}.`,
        409,
        "CANONICAL_PAYMENT_JOURNAL_GROSS_MISMATCH",
        {
          paymentId: payment.id,
          paymentGross: Number.isFinite(paymentGross) ? paymentGross : null,
          journalId: journal?.id ?? null,
          journalGross: Number.isFinite(journalGross) ? journalGross : null,
          difference,
          correctionRequired: true,
        },
      );
    }

    if (Math.abs(journalGross - paymentGross) > 0.01 && postedLinesProveGross) {
      await client.query(
        `insert into public.bank_reconciliation_audit
          (mutation_id, action, actor, meta)
         values ($1, 'QRIS_JOURNAL_HEADER_DRIFT_ACCEPTED', $2, $3::jsonb)`,
        [
          null,
          actor,
          JSON.stringify({
            payment_id: payment.id,
            journal_id: journal?.id ?? null,
            payment_gross: paymentGross,
            stored_journal_gross: journalGross,
            posted_debit_lines: baseDebit,
            posted_credit_lines: baseCredit,
            reason: "Posted journal lines are balanced and equal the canonical payment gross.",
          }),
        ],
      );
    }
  }

  const activeItemResult = await client.query<{ payment_id: number }>(
    `select psi.payment_id
       from sport_center.payment_settlement_items psi
       join sport_center.payment_settlement_batches psb
         on psb.id = psi.settlement_id
      where psi.payment_id = any($1::int[])
        and psi.item_status = 'active'
        and lower(coalesce(psb.status::text, '')) in ('draft', 'calculated', 'posted', 'reconciled')
      for update of psi, psb`,
    [normalizedPaymentIds],
  );
  if (activeItemResult.rows.length > 0) {
    throw new ApprovalError(
      "Sebagian payment QRIS sudah berada di settlement canonical lain. Muat ulang kandidat sebelum approval.",
      409,
      "CANONICAL_SETTLEMENT_SELECTION_CONFLICT",
    );
  }

  const configResult = await client.query<{
    id: number;
    calculation_method: string | null;
    rounding_scale: number | string | null;
    rounding_method: string | null;
    fixed_provider_fee: number | string | null;
    fee_tax_rate: number | string | null;
  }>(
    `select id,
            calculation_method,
            rounding_scale,
            rounding_method,
            fixed_provider_fee,
            fee_tax_rate
       from sport_center.payment_settlement_configs
      where company_id = $1
        and lower(btrim(provider_code)) = $2
        and btrim(bank_account_id::text) = $3
        and is_active = true
        and source = 'OWNER_APPROVED'
        and rule_version = $4
        and effective_from <= $5::date
        and (effective_until is null or $5::date < effective_until)
      order by id
      for update`,
    [companyId, providerCode, bankAccountId, ruleVersion, groupDate],
  );
  if (configResult.rows.length !== 1) {
    throw new ApprovalError(
      configResult.rows.length === 0
        ? "Konfigurasi settlement owner-approved untuk payment QRIS belum tersedia."
        : "Konfigurasi settlement QRIS memiliki lebih dari satu rule aktif.",
      409,
      configResult.rows.length === 0
        ? "CANONICAL_SETTLEMENT_CONFIG_REQUIRED"
        : "CANONICAL_SETTLEMENT_CONFIG_AMBIGUOUS",
    );
  }
  const settlementConfig = configResult.rows[0]!;
  if (
    !settlementConfig.calculation_method
    || settlementConfig.rounding_scale == null
    || !settlementConfig.rounding_method
    || settlementConfig.fixed_provider_fee == null
    || settlementConfig.fee_tax_rate == null
  ) {
    throw new ApprovalError(
      "Kolom finansial pada konfigurasi settlement owner-approved belum lengkap.",
      409,
      "CANONICAL_SETTLEMENT_CONFIG_REQUIRED",
    );
  }

  const identityResult = await client.query<{ correlation_id: string }>(
    `select correlation_id
       from sport_center.canonical_settlement_group_identity($1, $2, $3, $4::date, $5)`,
    [companyId, providerCode, bankAccountId, groupDate, ruleVersion],
  );
  const settlementReference = identityResult.rows[0]?.correlation_id;
  if (!settlementReference) {
    throw new ApprovalError(
      "Identitas group settlement canonical belum dapat ditentukan.",
      409,
      "CANONICAL_SETTLEMENT_IDENTITY_UNAVAILABLE",
    );
  }

  const bankCoaResult = await client.query<{ code: string }>(
    `select sc.code
       from public.company_bank_accounts cba
       join public.chart_of_accounts ca
         on ca.id = cba.coa_id
        and ca.code = '1-1023-CST'
        and ca.name = 'Bank Mandiri Ciputat'
        and ca.account_type::text = 'asset'
        and ca.is_active = true
       join sport_center.coa_accounts sc
         on sc.code = ca.code
        and sc.name = ca.name
        and sc.account_type::text = ca.account_type::text
        and sc.code = '1-1023-CST'
        and sc.name = 'Bank Mandiri Ciputat'
        and sc.account_type::text = 'asset'
        and sc.is_active = true
      where cba.company_id = $1
        and cba.account_number::text = $2
        and cba.is_active = true
      for update of cba, ca, sc`,
    [companyId, bankAccountId],
  );
  const bankCoaCode = bankCoaResult.rows.length === 1
    ? bankCoaResult.rows[0]?.code?.trim()
    : null;
  if (!bankCoaCode) {
    throw new ApprovalError(
      "COA bank canonical tidak terbukti memiliki mapping aktif untuk account settlement QRIS.",
      409,
      "CANONICAL_SETTLEMENT_BANK_COA_UNRESOLVED",
    );
  }

  await client.query(
    "set local sport_center.allow_posted_accounting_metadata_correction = 'on'",
  );

  let batchResult: { rows: Array<{ id: number | string }> };
  try {
    batchResult = await client.query(
      `select sport_center.create_payment_settlement_batch(
         $1, $2, $3, $4, $5::date, $6::int[], $7
       ) as id`,
      [
        settlementReference,
        companyId,
        providerCode,
        bankAccountId,
        groupDate,
        normalizedPaymentIds,
        actor,
      ],
    );
  } catch (error) {
    throw new ApprovalError(
      `Settlement canonical gagal dibuat: ${error instanceof Error ? error.message : String(error)}`,
      409,
      "CANONICAL_SETTLEMENT_BUILD_FAILED",
    );
  }
  const settlementId = safeInteger(batchResult.rows[0]?.id);
  if (settlementId === null) {
    throw new ApprovalError(
      "Owner settlement canonical tidak mengembalikan ID batch yang valid.",
      409,
      "CANONICAL_SETTLEMENT_BUILD_FAILED",
    );
  }

  const calculatedBatch = await client.query<{
    status: string;
    bank_mutation_id: number | null;
    settlement_rule_version: string | null;
  }>(
    `select status::text as status,
            bank_mutation_id,
            settlement_rule_version
       from sport_center.payment_settlement_batches
      where id = $1::bigint
      for update`,
    [settlementId],
  );
  const calculated = calculatedBatch.rows[0];
  if (
    !calculated
    || calculated.status !== "calculated"
    || calculated.bank_mutation_id != null
    || (
      calculated.settlement_rule_version !== ruleVersion
      && !String(calculated.settlement_rule_version ?? "").startsWith(`${ruleVersion}:SUPPLEMENTAL-`)
    )
  ) {
    throw new ApprovalError(
      "Owner settlement canonical mengembalikan batch yang tidak memenuhi kontrak calculated.",
      409,
      "CANONICAL_SETTLEMENT_BATCH_CONFLICT",
    );
  }

  let settlementJournalId: number | null = null;
  try {
    const journalDraft = await client.query<{ id: number | string }>(
      `select sport_center.create_settlement_journal_draft($1::bigint, $2, $3) as id`,
      [settlementId, bankCoaCode, actor],
    );
    settlementJournalId = safeInteger(journalDraft.rows[0]?.id);
    if (settlementJournalId === null) {
      throw new Error("owner journal function did not return a valid journal ID");
    }
    await client.query(
      `select sport_center.finalize_payment_settlement($1::bigint, $2) as id`,
      [settlementId, actor],
    );
  } catch (error) {
    throw new ApprovalError(
      `Jurnal settlement canonical gagal diposting: ${error instanceof Error ? error.message : String(error)}`,
      409,
      "CANONICAL_SETTLEMENT_FINALIZE_FAILED",
    );
  }

  const finalBatchResult = await client.query<{
    status: string;
    settlement_journal_id: number | string | null;
  }>(
    `select status::text as status, settlement_journal_id
       from sport_center.payment_settlement_batches
      where id = $1::bigint
      for update`,
    [settlementId],
  );
  const finalBatch = finalBatchResult.rows[0];
  const finalJournalId = safeInteger(finalBatch?.settlement_journal_id);
  if (
    !finalBatch
    || !["posted", "reconciled"].includes(finalBatch.status)
    || finalJournalId === null
    || finalJournalId !== settlementJournalId
  ) {
    throw new ApprovalError(
      "Settlement canonical selesai tetapi batch atau jurnal settlement tidak berstatus posted.",
      409,
      "CANONICAL_SETTLEMENT_JOURNAL_NOT_POSTED",
    );
  }

  const finalJournalResult = await client.query<{
    status: string;
    journal_type: string;
    is_reversal: boolean;
  }>(
    `select status,
            journal_type::text as journal_type,
            is_reversal
       from sport_center.accounting_journals
      where id = $1::bigint
      for update`,
    [finalJournalId],
  );
  const finalJournal = finalJournalResult.rows[0];
  const finalJournalBalance = await client.query<{
    debit: string | number;
    credit: string | number;
  }>(
    `select coalesce(sum(amount) filter (where line_type = 'debit'), 0) as debit,
            coalesce(sum(amount) filter (where line_type = 'credit'), 0) as credit
       from sport_center.accounting_journal_lines
      where journal_id = $1::bigint`,
    [finalJournalId],
  );
  const balance = finalJournalBalance.rows[0];
  if (
    !finalJournal
    || finalJournal.status !== "posted"
    || finalJournal.journal_type !== "settlement"
    || finalJournal.is_reversal
    || !balance
    || Math.abs(Number(balance.debit) - Number(balance.credit)) > 0.01
  ) {
    throw new ApprovalError(
      "Jurnal settlement canonical tidak posted atau tidak balanced.",
      409,
      "CANONICAL_SETTLEMENT_JOURNAL_INVALID",
    );
  }

  const finalItems = await client.query<{ payment_id: number }>(
    `select payment_id
       from sport_center.payment_settlement_items
      where settlement_id = $1::bigint
        and item_status = 'active'
      order by payment_id
      for update`,
    [settlementId],
  );
  const finalPaymentIds = finalItems.rows.map((row) => Number(row.payment_id));
  if (
    finalPaymentIds.length !== normalizedPaymentIds.length
    || finalPaymentIds.some((paymentId, index) => paymentId !== normalizedPaymentIds[index])
  ) {
    throw new ApprovalError(
      "Settlement canonical memiliki payment scope yang berbeda dari kandidat.",
      409,
      "CANONICAL_SETTLEMENT_IDEMPOTENCY_CONFLICT",
    );
  }

  const finalPayments = await client.query<{ id: number; settlement_status: string }>(
    `select id, settlement_status::text
       from sport_center.sport_payments
      where id = any($1::int[])
      order by id
      for update`,
    [normalizedPaymentIds],
  );
  if (
    finalPayments.rows.length !== normalizedPaymentIds.length
    || finalPayments.rows.some((payment) => payment.settlement_status !== "settled")
  ) {
    throw new ApprovalError(
      "Payment canonical tidak berubah menjadi settled setelah finalisasi.",
      409,
      "CANONICAL_PAYMENT_SETTLEMENT_STATE_CONFLICT",
    );
  }

  return resolveCanonicalQrisSettlement(client, companyId, normalizedPaymentIds);
}

async function listQrisCanonicalSettlements(
  companyId: number | null,
  includeCompleted: boolean,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const values: unknown[] = [];
  const filters = ["ebs.settlement_status in ('posted', 'reconciled')"];
  if (companyId !== null) {
    values.push(companyId);
    filters.push(`ebs.company_id = $${values.length}`);
  }
  if (!includeCompleted) {
    filters.push("ebs.settlement_status = 'posted'");
    filters.push("ebs.bank_mutation_id is null");
  }
  values.push(Math.min(Math.max(limit, 1), 500));

  const result = await pool.query(
    `select
       ebs.settlement_id as id,
       ebs.settlement_id as "candidateId",
       'sport_center.payment_settlement_batches' as "candidateSource",
       ebs.settlement_reference,
       ebs.settlement_date,
       ebs.settlement_status,
       ebs.provider_code,
       ebs.provider_name,
       ebs.company_id,
       ebs.gross_amount,
       ebs.mdr_amount,
       ebs.expected_bank_amount,
       ebs.settlement_journal_id,
       ebs.bank_mutation_id,
       case
         when ebs.settlement_status = 'reconciled' or ebs.bank_mutation_id is not null
           then 'completed'
         else 'active'
       end as queue_status,
       coalesce((
         select json_agg(json_build_object(
           'paymentId', psi.payment_id,
           'grossAmount', psi.gross_amount,
           'itemStatus', psi.item_status
         ) order by psi.payment_id)
         from sport_center.payment_settlement_items psi
         where psi.settlement_id = ebs.settlement_id
       ), '[]'::json) as payment_items,
       bm.status as bank_status,
       bm.transaction_date as bank_transaction_date,
       bm.amount as bank_amount,
       bm.description as bank_description
     from sport_center.expected_bank_settlements ebs
     left join public.bank_mutations bm on bm.id = ebs.bank_mutation_id
     where ${filters.join(" and ")}
     order by ebs.settlement_date desc nulls last, ebs.settlement_id desc
     limit $${values.length}`,
    values,
  );
  return result.rows;
}

router.get("/bank-reconciliation/qris-candidates", async (req, res): Promise<void> => {
  try {
    const rawCompanyId = queryString(req.query.companyId)
      ?? queryString(req.query.company_id)
      ?? queryString(req.query.company);
    const companyId = rawCompanyId === null || rawCompanyId === "" || rawCompanyId === "all"
      ? null
      : parsePositiveInt(rawCompanyId);
    if (rawCompanyId !== null && rawCompanyId !== "" && rawCompanyId !== "all" && companyId === null) {
      res.status(400).json({ error: "companyId tidak valid", code: "INVALID_COMPANY_ID" });
      return;
    }
    const requestedLimit = Number(queryString(req.query.limit) ?? 100);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;
    const includeCompleted = String(queryString(req.query.includeCompleted) ?? "").toLowerCase() === "true";
    const canonicalSettlements = await listQrisCanonicalSettlements(companyId, includeCompleted, limit);
    res.json({
      mode: "canonical_qris_settlement",
      automaticFinalReconciliation: false,
      automaticMatch: false,
      canonicalSettlements,
      candidates: canonicalSettlements,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    req.log.error({ error }, "Failed to load canonical QRIS settlements");
    res.status(code === "42P01" ? 503 : 500).json({
      error: code === "42P01" ? "Schema settlement QRIS canonical belum tersedia." : "Settlement QRIS canonical tidak dapat dimuat",
      code: code === "42P01" ? "QRIS_SCHEMA_UNAVAILABLE" : "QRIS_CANDIDATES_UNAVAILABLE",
    });
  }
});

router.post("/bank-reconciliation/qris-candidates/generate", async (_req, res): Promise<void> => {
  res.status(410).json({
    error: "Generator kandidat QRIS lama sudah dihapus. Gunakan settlement canonical Sport Center.",
    code: "LEGACY_QRIS_GENERATOR_REMOVED",
  });
});

router.post("/bank-reconciliation/qris-candidates/:candidateId/approve", async (_req, res): Promise<void> => {
  res.status(410).json({
    error: "Approval kandidat QRIS lama sudah dihapus. Approve candidate qris_settlement dengan candidate_source canonical.",
    code: "LEGACY_QRIS_APPROVAL_REMOVED",
  });
});

router.get("/bank-reconciliation/mutations/:mutationId", async (req, res): Promise<void> => {
  const actor = await getApprovalActor(req).catch(() => null);
  if (!actor) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const mutationId = parsePositiveInt(req.params.mutationId);
  if (mutationId === null) {
    res.status(400).json({ error: "ID mutasi tidak valid" });
    return;
  }

  try {
    const values: unknown[] = [mutationId];
    const filters = ["bm.id = $1"];
    if (actor.companyId != null) {
      values.push(actor.companyId);
      filters.push(`bm.company_id = ${values.length}`);
    }

    const result = await pool.query(
      `select ${mutationListColumns}
         from public.bank_mutations bm
        where ${filters.join(" and ")}
        limit 1`,
      values,
    );
    const rows = result.rows as MutationCandidateRow[];
    await hydrateMutationCandidateDetails(rows);
    await hydrateQrisReviewDiagnostics(rows);
    const mutation = rows[0];
    if (!mutation) {
      res.status(404).json({ error: "Mutasi tidak ditemukan" });
      return;
    }
    res.json({ mutation });
  } catch (error) {
    req.log.error({ error, mutationId }, "Failed to load bank mutation detail");
    res.status(503).json({
      error: "Detail mutasi bank tidak dapat dimuat",
      code: "BANK_RECONCILIATION_DETAIL_UNAVAILABLE",
    });
  }
});
router.get("/bank-reconciliation/mutations", async (req, res): Promise<void> => {
  try {
    const { where, values } = buildMutationFilters(req);
    const requestedLimit = parsePositiveInt(queryString(req.query.limit));
    const requestedOffset = Number(queryString(req.query.offset) ?? 0);
    const limit = Math.min(requestedLimit ?? 20, 1_000);
    const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;

    const countResult = await pool.query<{ total: string }>(
      `select count(*)::text as total
         from public.bank_mutations bm
        where ${where}`,
      values,
    );
    const listValues = [...values, limit, offset];
    const result = await pool.query(
      `select ${mutationListColumns}
         from public.bank_mutations bm
        where ${where}
        order by bm.transaction_date desc nulls last, bm.id desc
        limit $${listValues.length - 1}
       offset $${listValues.length}`,
      listValues,
    );
    await hydrateMutationCandidateDetails(result.rows as MutationCandidateRow[]);
    await hydrateQrisReviewDiagnostics(result.rows as MutationCandidateRow[]);

    res.json({
      mutations: result.rows,
      total: Number(countResult.rows[0]?.total ?? 0),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "INVALID_COMPANY") {
      res.status(400).json({ error: "company_id tidak valid" });
      return;
    }
    if (message === "INVALID_STATUS" || message === "INVALID_DIRECTION" || message === "INVALID_PAYMENT_TYPE") {
      res.status(400).json({ error: "Filter mutasi tidak valid" });
      return;
    }
    req.log.error({ error }, "Failed to load bank mutations");
    res.status(503).json({
      error: "Mutasi bank tidak dapat dimuat",
      code: "BANK_RECONCILIATION_SCHEMA_UNAVAILABLE",
    });
  }
});

router.get("/bank-reconciliation/summary", async (req, res): Promise<void> => {
  try {
    const { where, values } = buildMutationFilters(req);
    const result = await pool.query(
      `select bm.status, count(*)::text as count, coalesce(sum(bm.amount), 0)::text as total_amount
         from public.bank_mutations bm
        where ${where}
        group by bm.status
        order by bm.status`,
      values,
    );
    res.json({ summary: result.rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "INVALID_COMPANY") {
      res.status(400).json({ error: "company_id tidak valid" });
      return;
    }
    if (message === "INVALID_STATUS" || message === "INVALID_DIRECTION" || message === "INVALID_PAYMENT_TYPE") {
      res.status(400).json({ error: "Filter mutasi tidak valid" });
      return;
    }
    req.log.error({ error }, "Failed to load bank mutation summary");
    res.status(503).json({
      error: "Ringkasan mutasi bank tidak dapat dimuat",
      code: "BANK_RECONCILIATION_SCHEMA_UNAVAILABLE",
    });
  }
});

function normalizeInput(body: unknown): SheetConfigInput {
  if (!body || typeof body !== "object") return {};
  const value = body as Record<string, unknown>;
  return {
    company_id:
      value.company_id === null ? null : parsePositiveInt(value.company_id) ?? undefined,
    label: typeof value.label === "string" ? value.label.trim() : undefined,
    sheet_id: typeof value.sheet_id === "string" ? value.sheet_id.trim() : undefined,
    bank_account_number:
      value.bank_account_number === null
        ? null
        : typeof value.bank_account_number === "string"
          ? value.bank_account_number.trim() || null
          : undefined,
    bank_name:
      value.bank_name === null
        ? null
        : typeof value.bank_name === "string"
          ? value.bank_name.trim() || null
          : undefined,
    tab_name: typeof value.tab_name === "string" ? value.tab_name.trim() : undefined,
    is_active: typeof value.is_active === "boolean" ? value.is_active : undefined,
  };
}

const selectSheetConfigs = `
  select
    config.id,
    config.company_id,
    company.company_name,
    config.label,
    config.sheet_id,
    config.tab_name,
    config.bank_account_number,
    config.bank_name,
    config.is_active,
    config.last_synced_at,
    config.last_sync_status,
    config.last_sync_error
  from public.bank_sheet_configs config
  left join public.companies company on company.id = config.company_id
`;

router.get("/bank-reconciliation/sheet-configs", async (req, res): Promise<void> => {
  const companyId =
    req.query.company_id === undefined ? null : parsePositiveInt(req.query.company_id);
  if (req.query.company_id !== undefined && companyId === null) {
    res.status(400).json({ error: "company_id tidak valid" });
    return;
  }

  try {
    const result = await pool.query<SheetConfigRow>(
      `${selectSheetConfigs}
       ${companyId === null ? "" : "where config.company_id = $1"}
       order by config.is_active desc, config.label, config.id`,
      companyId === null ? [] : [companyId],
    );
    res.json({ configs: result.rows });
  } catch (error) {
    req.log.error({ error }, "Failed to load sheet configurations");
    res.status(503).json({ error: "Konfigurasi Google Sheet tidak dapat dimuat" });
  }
});

router.post("/bank-reconciliation/sheet-configs", async (req, res): Promise<void> => {
  const input = normalizeInput(req.body);
  if (!input.label || !input.sheet_id) {
    res.status(400).json({ error: "Label dan Sheet ID wajib diisi" });
    return;
  }

  try {
    const result = await pool.query<SheetConfigRow>(
      `insert into public.bank_sheet_configs
        (company_id, label, sheet_id, bank_account_number, bank_name, tab_name)
       values ($1, $2, $3, $4, $5, $6)
       returning *`,
      [
        input.company_id ?? null,
        input.label,
        input.sheet_id,
        input.bank_account_number ?? null,
        input.bank_name ?? null,
        input.tab_name || "Mutasi_Bank",
      ],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    req.log.error({ error }, "Failed to create sheet configuration");
    res.status(503).json({ error: "Konfigurasi Google Sheet gagal disimpan" });
  }
});

router.put("/bank-reconciliation/sheet-configs/:id", async (req, res): Promise<void> => {
  const id = parsePositiveInt(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "ID konfigurasi tidak valid" });
    return;
  }

  const input = normalizeInput(req.body);
  const fields: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown): void => {
    values.push(value);
    fields.push(`${column} = $${values.length}`);
  };
  if (input.company_id !== undefined) add("company_id", input.company_id);
  if (input.label !== undefined) add("label", input.label);
  if (input.sheet_id !== undefined) add("sheet_id", input.sheet_id);
  if (input.bank_account_number !== undefined) add("bank_account_number", input.bank_account_number);
  if (input.bank_name !== undefined) add("bank_name", input.bank_name);
  if (input.tab_name !== undefined) add("tab_name", input.tab_name || "Mutasi_Bank");
  if (input.is_active !== undefined) add("is_active", input.is_active);
  if (fields.length === 0) {
    res.status(400).json({ error: "Tidak ada perubahan yang valid" });
    return;
  }

  values.push(id);
  try {
    const result = await pool.query<SheetConfigRow>(
      `update public.bank_sheet_configs
       set ${fields.join(", ")}, updated_at = now()
       where id = $${values.length}
       returning *`,
      values,
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Konfigurasi tidak ditemukan" });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    req.log.error({ error }, "Failed to update sheet configuration");
    res.status(503).json({ error: "Konfigurasi Google Sheet gagal diperbarui" });
  }
});

router.delete("/bank-reconciliation/sheet-configs/:id", async (req, res): Promise<void> => {
  const id = parsePositiveInt(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "ID konfigurasi tidak valid" });
    return;
  }

  try {
    const result = await pool.query<{ id: number }>(
      "delete from public.bank_sheet_configs where id = $1 returning id",
      [id],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Konfigurasi tidak ditemukan" });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ error }, "Failed to delete sheet configuration");
    res.status(503).json({ error: "Konfigurasi Google Sheet gagal dihapus" });
  }
});

router.post("/bank-reconciliation/sheet-configs/:id/test", async (req, res): Promise<void> => {
  const id = parsePositiveInt(req.params.id);
  if (id === null) {
    res.status(400).json({ ok: false, error: "ID konfigurasi tidak valid" });
    return;
  }

  try {
    const config = await pool.query<{ sheet_id: string; tab_name: string }>(
      "select sheet_id, tab_name from public.bank_sheet_configs where id = $1",
      [id],
    );
    if (config.rowCount === 0) {
      res.status(404).json({ ok: false, error: "Konfigurasi tidak ditemukan" });
      return;
    }

    const row = config.rows[0]!;
    const metadata = await inspectSpreadsheet(row.sheet_id);
    const tabExists = metadata.tabs.includes(row.tab_name);
    res.json({
      ok: tabExists,
      stage: tabExists ? "ready" : "tab",
      message: tabExists ? "Spreadsheet dan tab dapat diakses" : undefined,
      error: tabExists ? undefined : `Tab "${row.tab_name}" tidak ditemukan`,
      hint: tabExists ? undefined : "Periksa Nama Tab pada konfigurasi",
      spreadsheetTitle: metadata.title,
      availableTabs: metadata.tabs,
      tabExists,
      serviceAccountEmail: metadata.serviceAccountEmail,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tes Google Sheet gagal";
    req.log.warn({ errorMessage: message, configId: id }, "Google Sheet test failed");
    res.status(502).json({
      ok: false,
      stage: "access",
      error: message,
      hint: "Pastikan sheet sudah dibagikan ke Service Account sebagai Editor",
    });
  }
});

router.post("/bank-reconciliation/sheet-configs/:id/sync", async (req, res): Promise<void> => {
  const id = parsePositiveInt(req.params.id);
  if (id === null) {
    res.status(400).json({ ok: false, error: "ID konfigurasi tidak valid" });
    return;
  }
  try {
    res.json(await syncOneBankSheetConfig(id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sheet sync gagal";
    req.log.error({ error, configId: id }, "Google Sheet sync failed");
    res.status(502).json({ ok: false, error: message });
  }
});

router.post("/bank-reconciliation/sheet-sync", async (req, res): Promise<void> => {
  const rawCompanyId = req.query.company_id;
  const companyId =
    rawCompanyId === undefined || rawCompanyId === "" || rawCompanyId === "all"
      ? undefined
      : parsePositiveInt(rawCompanyId);
  if (rawCompanyId !== undefined && companyId === null) {
    res.status(400).json({ error: "company_id tidak valid" });
    return;
  }
  try {
    const summaries = await syncAllBankSheetConfigs(companyId ?? undefined);
    const imported = summaries.reduce((sum, item) => sum + Number(item.imported ?? 0), 0);
    res.json({
      ok: true,
      imported,
      configs: summaries,
      message: `Sync dari Google Sheet selesai: ${imported} mutasi baru`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sheet sync gagal";
    req.log.error({ error, companyId }, "Google Sheet sync failed");
    res.status(502).json({ error: message, code: "GOOGLE_SHEET_SYNC_FAILED" });
  }
});


router.post("/bank-reconciliation/:mutationId/vendor-invoice-payment-batch", async (req, res): Promise<void> => {
  const mutationId = parsePositiveInt(req.params.mutationId);
  const requestedCompanyId = parsePositiveInt(req.header("x-company-id") ?? req.query.company);
  if (mutationId === null || requestedCompanyId === null) {
    res.status(400).json({ error: "ID mutasi atau company tidak valid" });
    return;
  }

  let actor: ApprovalActor | null;
  try {
    actor = await getApprovalActor(req);
  } catch (error) {
    req.log.error({ error, mutationId }, "Failed to resolve vendor invoice payment actor");
    res.status(503).json({ error: "Authorization service unavailable" });
    return;
  }
  if (!actor) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const rawIds = Array.isArray(req.body?.vendor_invoice_ids) ? req.body.vendor_invoice_ids : [];
  const vendorInvoiceIds = Array.from(new Set(
    rawIds.map((value: unknown) => Number(value)).filter((value: number) => Number.isSafeInteger(value) && value > 0),
  ));
  if (vendorInvoiceIds.length === 0 || vendorInvoiceIds.length !== rawIds.length) {
    res.status(400).json({ error: "Minimal satu invoice vendor yang valid wajib dipilih" });
    return;
  }

  const requestedAllocationByInvoice = new Map<number, number>();
  const rawAllocations = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
  for (const rawAllocation of rawAllocations as Array<Record<string, unknown>>) {
    const invoiceId = Number(rawAllocation.vendor_invoice_id ?? rawAllocation.invoice_id);
    const amount = Math.round(Number(rawAllocation.amount) * 100) / 100;
    if (
      !Number.isSafeInteger(invoiceId)
      || invoiceId <= 0
      || !Number.isFinite(amount)
      || amount <= 0
      || !vendorInvoiceIds.includes(invoiceId)
      || requestedAllocationByInvoice.has(invoiceId)
    ) {
      res.status(400).json({ error: "Alokasi invoice tidak valid atau duplikat" });
      return;
    }
    requestedAllocationByInvoice.set(invoiceId, amount);
  }

  const money = (value: number): number => Math.round(value * 100) / 100;
  const client = await pool.connect();
  try {
    await client.query("begin");

    const mutationResult = await client.query<{
      id: number;
      company_id: number;
      amount: string;
      direction: string;
      transaction_date: string;
      mutation_key: string | null;
      bank_reference: string | null;
      description: string | null;
      bank_account_id: string | null;
      journal_entry_id: number | null;
      status: string;
    }>(
      `select id, company_id, amount, direction, transaction_date, mutation_key,
              bank_reference, description, bank_account_id, journal_entry_id, status
         from public.bank_mutations
        where id = $1
        for update`,
      [mutationId],
    );
    const mutation = mutationResult.rows[0];
    if (!mutation) throw new ApprovalError("Mutasi bank tidak ditemukan", 404, "MUTATION_NOT_FOUND");

    const companyId = Number(mutation.company_id);
    const mutationAmount = money(Number(mutation.amount));
    if (companyId !== requestedCompanyId) {
      throw new ApprovalError("Company mutasi tidak sesuai dengan perusahaan aktif", 409, "COMPANY_MISMATCH");
    }
    if (actor.companyId != null && actor.companyId !== companyId) {
      throw new ApprovalError("Akses perusahaan tidak sesuai", 403, "COMPANY_ACCESS_DENIED");
    }
    if (String(mutation.direction ?? "").toUpperCase() !== "OUT") {
      throw new ApprovalError("Hanya mutasi uang keluar yang dapat dialokasikan ke invoice vendor", 422, "INVALID_DIRECTION");
    }
    if (!Number.isFinite(mutationAmount) || mutationAmount <= 0) {
      throw new ApprovalError("Nominal mutasi tidak valid", 422, "INVALID_AMOUNT");
    }
    if (
      mutation.journal_entry_id != null
      || ["approved", "approved_pending_posting", "posted", "reconciled"].includes(String(mutation.status ?? "").toLowerCase())
    ) {
      throw new ApprovalError("Mutasi ini sudah memiliki jurnal atau sudah diproses", 409, "MUTATION_ALREADY_PROCESSED");
    }

    const invoiceResult = await client.query<{
      id: number;
      invoice_number: string;
      vendor_invoice_ref: string | null;
      supplier_name: string;
      grand_total: string;
      status: string;
      canonical_paid: string;
    }>(
      `select vi.id, vi.invoice_number, vi.vendor_invoice_ref, vi.supplier_name,
              vi.grand_total, vi.status::text status,
              coalesce((
                select sum(coalesce(pa.allocated_amount, 0))
                  from public.payment_allocations pa
                  left join public.payment_matching_groups pmg on pmg.id = pa.group_id
                  left join public.bank_mutations bm on bm.id = pa.mutation_id
                 where pa.invoice_id = vi.id
                   and pa.company_id = vi.company_id
                   and coalesce(pa.is_active, true) = true
                   and (
                     lower(coalesce(pmg.status, '')) in ('final', 'posted', 'reconciled')
                     or lower(coalesce(bm.status, '')) in ('final', 'posted', 'reconciled')
                   )
              ), 0)::text canonical_paid
         from public.vendor_invoices vi
        where vi.company_id = $1
          and vi.id = any($2::bigint[])
          and vi.cancelled_at is null
        order by vi.id
        for update`,
      [companyId, vendorInvoiceIds],
    );
    if (invoiceResult.rows.length !== vendorInvoiceIds.length) {
      throw new ApprovalError("Satu atau lebih invoice vendor tidak ditemukan dalam perusahaan aktif", 404, "INVOICE_NOT_FOUND");
    }

    const taxResult = await client.query<{
      invoice_id: number;
      tax_type: string;
      tax_amount: string;
      liability_account_id: number | null;
    }>(
      `select vil.invoice_id, vit.tax_type, vit.tax_amount, vit.liability_account_id
         from public.vendor_invoice_line_taxes vit
         join public.vendor_invoice_lines vil on vil.id = vit.invoice_line_id
        where vil.invoice_id = any($1::bigint[])
          and vit.company_id = $2
          and coalesce(vit.tax_amount, 0) > 0
        order by vil.invoice_id, vit.id`,
      [vendorInvoiceIds, companyId],
    );
    const taxesByInvoice = new Map<number, Array<{ taxType: string; amount: number; liabilityAccountId: number | null }>>();
    for (const row of taxResult.rows) {
      const rows = taxesByInvoice.get(Number(row.invoice_id)) ?? [];
      rows.push({
        taxType: String(row.tax_type ?? "PPh"),
        amount: money(Number(row.tax_amount ?? 0)),
        liabilityAccountId: row.liability_account_id == null ? null : Number(row.liability_account_id),
      });
      taxesByInvoice.set(Number(row.invoice_id), rows);
    }

    const allocations = invoiceResult.rows.map((invoice) => {
      if (String(invoice.status).toLowerCase() !== "posted") {
        throw new ApprovalError(
          `Invoice ${invoice.vendor_invoice_ref ?? invoice.invoice_number} harus berstatus posted sebelum dibayar`,
          422,
          "INVOICE_NOT_POSTED",
        );
      }
      const grandTotal = money(Number(invoice.grand_total));
      const canonicalPaid = money(Number(invoice.canonical_paid ?? 0));
      const outstanding = money(Math.max(0, grandTotal - canonicalPaid));
      if (!Number.isFinite(outstanding) || outstanding <= 0.01) {
        throw new ApprovalError(
          `Invoice ${invoice.vendor_invoice_ref ?? invoice.invoice_number} sudah tersettle penuh`,
          409,
          "INVOICE_ALREADY_SETTLED",
        );
      }
      const requested = requestedAllocationByInvoice.get(invoice.id);
      const cashAmount = requested != null
        ? requested
        : invoiceResult.rows.length === 1
          ? money(Math.min(mutationAmount, outstanding))
          : outstanding;
      if (!Number.isFinite(cashAmount) || cashAmount <= 0 || cashAmount > outstanding + 0.01) {
        throw new ApprovalError(
          `Alokasi invoice ${invoice.vendor_invoice_ref ?? invoice.invoice_number} tidak valid atau melebihi sisa invoice`,
          422,
          "INVALID_INVOICE_ALLOCATION",
        );
      }

      const taxes = taxesByInvoice.get(invoice.id) ?? [];
      const withholdingAmount = money(taxes.reduce((sum, tax) => sum + Math.max(0, tax.amount), 0));
      const inferWithholding = withholdingAmount > 0
        && Math.abs(cashAmount - money(outstanding - withholdingAmount)) <= 0.01;
      if (inferWithholding) {
        const unmapped = taxes.find((tax) => !Number.isInteger(tax.liabilityAccountId) || Number(tax.liabilityAccountId) <= 0);
        if (unmapped) {
          throw new ApprovalError(
            `COA Hutang PPh untuk invoice ${invoice.vendor_invoice_ref ?? invoice.invoice_number} belum terpetakan`,
            422,
            "WITHHOLDING_LIABILITY_ACCOUNT_REQUIRED",
          );
        }
      }
      const grossAmount = money(cashAmount + (inferWithholding ? withholdingAmount : 0));
      return {
        ...invoice,
        grandTotal,
        canonicalPaid,
        outstanding,
        cashAmount,
        grossAmount,
        withholdingAmount: inferWithholding ? withholdingAmount : 0,
        liabilityCredits: inferWithholding
          ? taxes.map((tax) => ({ accountId: Number(tax.liabilityAccountId), amount: tax.amount }))
          : [],
      };
    });

    const totalCashAllocation = money(allocations.reduce((sum, allocation) => sum + allocation.cashAmount, 0));
    if (totalCashAllocation > mutationAmount + 0.01) {
      throw new ApprovalError(
        `Nominal mutasi (${mutationAmount.toFixed(2)}) tidak cukup untuk total alokasi invoice (${totalCashAllocation.toFixed(2)})`,
        422,
        "ALLOCATION_EXCEEDS_MUTATION",
      );
    }
    const wrongTransferAmount = money(Math.max(0, mutationAmount - totalCashAllocation));

    const bankCoaId = await resolveApprovalBankAccount(
      client,
      companyId,
      mutation.bank_account_id == null ? null : String(mutation.bank_account_id),
    );
    if (bankCoaId == null) {
      throw new ApprovalError("COA rekening bank belum dikonfigurasi", 422, "BANK_COA_REQUIRED");
    }
    const bankAccountResult = await client.query<{ id: number; code: string; name: string }>(
      `select id, code, name
         from public.chart_of_accounts
        where id = $1
          and (company_id = $2 or company_id is null)
          and coalesce(is_active, true) = true
          and coalesce(is_postable, true) = true
        limit 1`,
      [bankCoaId, companyId],
    );
    const bankAccount = bankAccountResult.rows[0];
    if (!bankAccount) {
      throw new ApprovalError("COA rekening bank tidak aktif atau tidak postable", 422, "BANK_COA_REQUIRED");
    }

    const apAccount = await resolveApprovalContraAccount(client, companyId, "OUT", "vendor_invoice", null);
    const wrongTransferAccount = wrongTransferAmount > 0.01
      ? (await client.query<{ id: number; code: string; name: string }>(
          `select id, code, name
             from public.chart_of_accounts
            where code = '2-1011-CST'
              and (company_id = $1 or company_id is null)
              and coalesce(is_active, true) = true
              and coalesce(is_postable, true) = true
            order by case when company_id = $1 then 0 else 1 end, id
            limit 1`,
          [companyId],
        )).rows[0]
      : null;
    if (wrongTransferAmount > 0.01 && !wrongTransferAccount) {
      throw new ApprovalError("COA 2-1011-CST — Salah Transfer belum tersedia atau tidak aktif", 422, "WRONG_TRANSFER_COA_REQUIRED");
    }

    const settingsResult = await client.query<{ bank_journal_id: number | null }>(
      "select bank_journal_id from public.accounting_settings where company_id = $1 limit 1",
      [companyId],
    );
    let journalId = settingsResult.rows[0]?.bank_journal_id ?? null;
    if (journalId == null) {
      const journalFallback = await client.query<{ id: number }>(
        `select id
           from public.accounting_journals
          where company_id = $1
            and (lower(name) like '%bank%' or lower(code) like '%bank%' or type = 'bank')
          order by id
          limit 1`,
        [companyId],
      );
      journalId = journalFallback.rows[0]?.id ?? null;
    }
    if (journalId == null) {
      throw new ApprovalError("Jurnal bank belum dikonfigurasi untuk perusahaan ini", 422, "JOURNAL_MAPPING_REQUIRED");
    }

    const txDate = calendarDateValue(mutation.transaction_date);
    if (!txDate) throw new ApprovalError("Tanggal transaksi mutasi tidak valid", 422, "INVALID_TRANSACTION_DATE");
    const year = Number(txDate.slice(0, 4)) || new Date().getUTCFullYear();
    const entryNumber = await nextApprovalEntryNumber(client, companyId, year);
    const reference = String(mutation.mutation_key ?? mutation.bank_reference ?? mutationId).slice(0, 100);
    const description = `Pembayaran ${allocations.length} invoice vendor — ${reference}`.slice(0, 200);
    const totalWithholding = money(allocations.reduce((sum, allocation) => sum + allocation.withholdingAmount, 0));
    const totalDebit = money(allocations.reduce((sum, allocation) => sum + allocation.grossAmount, 0) + wrongTransferAmount);
    const totalCredit = money(mutationAmount + totalWithholding);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new ApprovalError("Jurnal pembayaran vendor tidak balance", 422, "UNBALANCED_JOURNAL");
    }

    const entryResult = await client.query<{ id: number }>(
      `insert into public.accounting_entries
        (entry_number, journal_id, date, ref, description, status, source, source_id,
         total_debit, total_credit, created_by_id, company_id)
       values ($1, $2, $3, $4, $5, 'draft', 'bank_reconciliation', $6,
               $7, $8, $9, $10)
       returning id`,
      [entryNumber, journalId, txDate, reference, description, mutationId, totalDebit, totalCredit, actor.email, companyId],
    );
    const entryId = entryResult.rows[0]?.id;
    if (!entryId) throw new Error("Jurnal pembayaran vendor gagal dibuat");

    for (const allocation of allocations) {
      await client.query(
        `insert into public.accounting_entry_lines (entry_id, account_id, debit, credit, description)
         values ($1, $2, $3, 0, $4)`,
        [entryId, apAccount.id, allocation.grossAmount, `Pembayaran invoice vendor ${allocation.vendor_invoice_ref ?? allocation.invoice_number}`.slice(0, 200)],
      );
    }
    if (wrongTransferAccount && wrongTransferAmount > 0.01) {
      await client.query(
        `insert into public.accounting_entry_lines (entry_id, account_id, debit, credit, description)
         values ($1, $2, $3, 0, $4)`,
        [entryId, wrongTransferAccount.id, wrongTransferAmount, `Kelebihan transfer — ${wrongTransferAccount.code} ${wrongTransferAccount.name}`.slice(0, 200)],
      );
    }
    const liabilityCredits = new Map<number, number>();
    for (const allocation of allocations) {
      for (const credit of allocation.liabilityCredits) {
        liabilityCredits.set(credit.accountId, money((liabilityCredits.get(credit.accountId) ?? 0) + credit.amount));
      }
    }
    for (const [accountId, amount] of liabilityCredits) {
      await client.query(
        `insert into public.accounting_entry_lines (entry_id, account_id, debit, credit, description)
         values ($1, $2, 0, $3, 'Hutang PPh — matching invoice vendor')`,
        [entryId, accountId, amount],
      );
    }
    await client.query(
      `insert into public.accounting_entry_lines (entry_id, account_id, debit, credit, description)
       values ($1, $2, 0, $3, $4)`,
      [entryId, bankAccount.id, mutationAmount, description],
    );

    const groupResult = await client.query<{ id: number }>(
      `insert into public.payment_matching_groups
        (company_id, group_type, matching_type, total_mutation_amount, total_invoice_amount,
         total_allocated, remaining_amount, confidence, algorithm_used, status, created_by)
       values ($1, 'MULTI_INVOICE', 'MULTI_INVOICE', $2, $3, $3, $4, 100,
               'bank_reconciliation_vendor_invoice_batch', 'active', $5)
       returning id`,
      [
        companyId,
        mutationAmount,
        money(allocations.reduce((sum, allocation) => sum + allocation.grossAmount, 0)),
        wrongTransferAmount,
        actor.email,
      ],
    );
    const groupId = groupResult.rows[0]?.id;
    if (!groupId) throw new Error("Matching group pembayaran vendor gagal dibuat");

    for (let index = 0; index < allocations.length; index += 1) {
      const allocation = allocations[index]!;
      await client.query(
        `insert into public.payment_allocations
          (group_id, company_id, invoice_id, invoice_ref, mutation_id, allocated_amount,
           remaining_amount, allocation_sequence, strategy, is_active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'MANUAL', true)`,
        [
          groupId,
          companyId,
          allocation.id,
          allocation.vendor_invoice_ref ?? allocation.invoice_number,
          mutationId,
          allocation.grossAmount,
          money(Math.max(0, allocation.outstanding - allocation.grossAmount)),
          index + 1,
        ],
      );
    }

    await client.query(
      `update public.bank_reconciliation_matches
          set status = 'superseded'
        where mutation_id = $1
          and status not in ('approved', 'posted')`,
      [mutationId],
    );
    await client.query(
      `insert into public.bank_reconciliation_matches
        (mutation_id, candidate_type, candidate_id, match_score, match_reason,
         amount_match, date_match, name_match, order_id_match, proof_match,
         status, candidate_source, is_manual)
       values ($1, 'vendor_invoice', $2, 100, $3, $4, false, true, false, false,
               'approved', 'public.vendor_invoices', true)`,
      [
        mutationId,
        allocations[0]!.id,
        `vendor invoice batch payment; invoice_ids:${allocations.map((allocation) => allocation.id).join(",")}`,
        wrongTransferAmount <= 0.01,
      ],
    );

    await client.query(
      `update public.bank_mutations
          set status = 'approved_pending_posting',
              reconciliation_status = 'matched',
              journal_entry_id = $1,
              approved_by = $2,
              approved_at = now(),
              linked_transaction_type = 'vendor_invoice_batch',
              linked_transaction_id = $3,
              updated_at = now()
        where id = $4`,
      [entryId, actor.email, allocations[0]!.id, mutationId],
    );

    await client.query(
      `insert into public.bank_reconciliation_audit (mutation_id, action, actor, meta)
       values ($1, 'MATCH_APPROVED', $2, $3::jsonb)`,
      [
        mutationId,
        actor.email,
        JSON.stringify({
          candidate_type: "vendor_invoice_batch",
          candidate_ids: allocations.map((allocation) => allocation.id),
          cash_amounts: allocations.map((allocation) => allocation.cashAmount),
          gross_amounts: allocations.map((allocation) => allocation.grossAmount),
          withholding_amounts: allocations.map((allocation) => allocation.withholdingAmount),
          total_amount: mutationAmount,
          wrong_transfer_amount: wrongTransferAmount,
          wrong_transfer_coa_code: wrongTransferAccount?.code ?? null,
          payment_matching_group_id: groupId,
          journal_entry_id: entryId,
          bank_coa_id: bankAccount.id,
          bank_coa_code: bankAccount.code,
          bank_coa_name: bankAccount.name,
          ap_coa_id: apAccount.id,
          ap_coa_code: apAccount.code,
          ap_coa_name: apAccount.name,
        }),
      ],
    );

    await client.query("commit");
    res.json({
      ok: true,
      mutation_id: mutationId,
      journal_entry_id: entryId,
      journal_entry_number: entryNumber,
      status: "approved_pending_posting",
      payment_matching_group_id: groupId,
      bank_coa: { id: bankAccount.id, code: bankAccount.code, name: bankAccount.name },
      ap_coa: { id: apAccount.id, code: apAccount.code, name: apAccount.name },
      wrong_transfer_amount: wrongTransferAmount,
      invoices: allocations.map((allocation) => ({
        vendor_invoice_id: allocation.id,
        invoice_number: allocation.vendor_invoice_ref ?? allocation.invoice_number,
        cash_amount: allocation.cashAmount,
        settled_amount: allocation.grossAmount,
      })),
    });
  } catch (error) {
    try {
      await client.query("rollback");
    } catch (rollbackError) {
      req.log.warn({ rollbackError, mutationId }, "Vendor invoice payment rollback failed");
    }
    const status = error instanceof ApprovalError ? error.status : 400;
    const code = error instanceof ApprovalError ? error.code : "VENDOR_INVOICE_PAYMENT_FAILED";
    const message = error instanceof Error ? error.message : "Pembayaran invoice vendor gagal diproses";
    req.log.warn({ error, mutationId, requestedCompanyId }, "Vendor invoice payment batch rejected");
    res.status(status).json({ error: message, code });
  } finally {
    client.release();
  }
});

router.get("/bank-reconciliation/:mutationId/vendor-invoice-candidates", async (req, res): Promise<void> => {
  const mutationId = parsePositiveInt(req.params.mutationId);
  const companyId = parsePositiveInt(req.header("x-company-id") ?? req.query.company);
  if (mutationId === null || companyId === null) {
    res.status(400).json({ error: "ID mutasi atau company tidak valid" });
    return;
  }

  try {
    const result = await pool.query<{
      id: number;
      invoice_number: string;
      vendor_invoice_ref: string | null;
      supplier_name: string;
      subtotal: string;
      tax_amount: string;
      grand_total: string;
      canonical_paid: string;
      remaining_net: string;
      due_date: string | null;
      withholding_tax_amount: string | null;
      invoice_breakdown: unknown;
      tax_review_status: string | null;
    }>(
      `with requested_mutation as (
         select id
         from public.bank_mutations
         where id = $1
           and company_id = $2
       ),
       canonical_invoice_payments as (
         select pa.invoice_id,
                sum(coalesce(pa.allocated_amount, 0))::numeric canonical_paid
         from public.payment_allocations pa
         join public.payment_matching_groups pmg on pmg.id = pa.group_id
         join public.bank_mutations bm
           on bm.id = pa.mutation_id
          and bm.company_id = pa.company_id
         where pa.company_id = $2
           and pa.mutation_id is not null
           and coalesce(pa.is_active, true) = true
           and (
             lower(coalesce(pmg.status, '')) in ('final', 'posted', 'reconciled')
             or lower(coalesce(bm.status, '')) in ('final', 'posted', 'reconciled')
           )
         group by pa.invoice_id
       ),
       eligible_invoices as (
         select vi.id,
                vi.invoice_number,
                vi.vendor_invoice_ref,
                vi.supplier_name,
                vi.total_amount subtotal,
                vi.tax_amount,
                vi.grand_total,
                coalesce(cip.canonical_paid, 0)::numeric canonical_paid,
                greatest(vi.grand_total - coalesce(cip.canonical_paid, 0), 0)::numeric remaining_net,
                vi.due_date,
                vi.withholding_tax_amount,
                vi.invoice_breakdown,
                vi.tax_review_status
         from public.vendor_invoices vi
         join public.suppliers s
           on s.id = vi.supplier_id
          and coalesce(s.is_active, false) = true
          and lower(coalesce(s.status, 'active')) not in ('inactive', 'disabled', 'suspended', 'deleted')
         left join canonical_invoice_payments cip on cip.invoice_id = vi.id
         where vi.company_id = $2
           and vi.status::text = 'posted'
           and greatest(vi.grand_total - coalesce(cip.canonical_paid, 0), 0) > 0
       )
       select ei.*
       from eligible_invoices ei
       cross join requested_mutation
       order by ei.due_date nulls last, ei.id`,
      [mutationId, companyId],
    );

    const invoiceIds = result.rows.map((row) => row.id);
    const withholdingResult = invoiceIds.length === 0
      ? { rows: [] }
      : await pool.query<{
          invoice_id: number;
          line_tax_id: number;
          invoice_line_id: number;
          tax_type: string;
          tax_object: string;
          tax_amount: string;
          base_amount: string;
          liability_account_id: number | null;
          resolution_status: string | null;
          coa_code: string | null;
          coa_name: string | null;
        }>(
          `select vil.invoice_id,
                  vit.id line_tax_id,
                  vit.invoice_line_id,
                  vit.tax_type,
                  vit.tax_object,
                  vit.tax_amount,
                  vil.subtotal base_amount,
                  vit.liability_account_id,
                  vit.resolution_status,
                  coa.code coa_code,
                  coa.name coa_name
             from public.vendor_invoice_line_taxes vit
             join public.vendor_invoice_lines vil on vil.id = vit.invoice_line_id
             left join public.chart_of_accounts coa on coa.id = vit.liability_account_id
            where vil.invoice_id = any($1::bigint[])
              and coalesce(vit.tax_amount, 0) > 0
            order by vil.invoice_id, vit.id`,
          [invoiceIds],
        );
    const withholdingByInvoice = new Map<number, typeof withholdingResult.rows>();
    for (const row of withholdingResult.rows) {
      const rows = withholdingByInvoice.get(row.invoice_id) ?? [];
      rows.push(row);
      withholdingByInvoice.set(row.invoice_id, rows);
    }

    res.json({
      invoices: result.rows.map((row) => ({
        id: row.id,
        docNumber: row.invoice_number,
        billNumber: row.vendor_invoice_ref,
        supplierName: row.supplier_name,
        subtotal: Number(row.subtotal),
        taxAmount: Number(row.tax_amount),
        grandTotal: Number(row.grand_total),
        amountPaid: Number(row.canonical_paid),
        outstanding: Number(row.remaining_net),
        dueDate: row.due_date,
        withholdingTaxAmount: row.withholding_tax_amount == null ? undefined : Number(row.withholding_tax_amount),
        invoiceBreakdown: row.invoice_breakdown,
        taxReviewStatus: row.tax_review_status,
        withholdingLines: (withholdingByInvoice.get(row.id) ?? []).map((tax) => ({
          lineTaxId: tax.line_tax_id,
          invoiceLineId: tax.invoice_line_id,
          taxType: tax.tax_type,
          taxObject: tax.tax_object,
          amount: Number(tax.tax_amount),
          baseAmount: Number(tax.base_amount),
          liabilityAccountId: tax.liability_account_id,
          resolutionStatus: tax.resolution_status,
          coaCode: tax.coa_code,
          coaName: tax.coa_name,
        })),
        source: "vendor_invoice",
        settlementStatus: Number(row.canonical_paid) > 0 ? "partially_settled" : "outstanding",
      })),
    });
  } catch (error) {
    req.log.error({ error, mutationId, companyId }, "Failed to load vendor invoice candidates");
    res.status(503).json({ error: "Kandidat invoice vendor tidak dapat dimuat" });
  }
});

export default router;