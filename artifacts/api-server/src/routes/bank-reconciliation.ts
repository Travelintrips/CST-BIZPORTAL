import { Router, type IRouter, type Request } from "express";
import { pool } from "@workspace/db";
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
}

interface LocalMatchCandidate {
  candidateType: "sport_payment" | "vendor_invoice";
  candidateId: number;
  score: number;
  amountMatch: boolean;
  dateMatch: boolean;
  referenceMatch: boolean;
  nameMatch: boolean;
  reason: string;
}

class ApprovalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
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

function safeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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
  const date = String(mutation.transaction_date).slice(0, 10);
  const direction = String(mutation.direction ?? "").toUpperCase();
  const candidates: LocalMatchCandidate[] = [];

  if (direction === "IN") {
    try {
      const sportPayments = await client.query<{
        id: number;
        amount: string;
        paid_date: string | null;
        payment_reference: string | null;
        description: string | null;
      }>(
        `select sp.id,
                sp.amount,
                coalesce(sp.paid_at, sp.created_at)::date::text as paid_date,
                coalesce(sp.provider_order_id, sp.provider_id::text) as payment_reference,
                concat_ws(' ', sp.payment_type, sp.payment_provider, sp.provider_order_id) as description
           from sport_center.sport_payments sp
          where sp.company_id = $1
            and lower(coalesce(sp.status::text, '')) in
                ('confirmed', 'paid', 'completed', 'success', 'settled')
            and abs(sp.amount::numeric - $2::numeric) < 0.01
            and (
              coalesce(sp.paid_at, sp.created_at)::date = $3::date
              or coalesce(sp.settlement_date, (coalesce(sp.paid_at, sp.created_at)::date + 1)) = $3::date
            )
            and not exists (
              select 1
                from public.bank_reconciliation_matches brm
               where brm.candidate_type = 'sport_payment'
                 and brm.candidate_id = sp.id
                 and brm.status in ('approved', 'posted')
            )
          order by sp.id`,
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
            : dateMatch
              ? "Nominal dan tanggal payment cocok."
              : "Nominal dan tanggal settlement cocok.",
        });
      }
    } catch (error) {
      // Sport Center is an optional source on installations that only use
      // bank imports and vendor invoices. Keep matching usable when that
      // optional schema is not installed.
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
        `select vi.id,
                vi.invoice_number,
                vi.vendor_invoice_ref,
                vi.supplier_name,
                vi.grand_total,
                vi.due_date
           from public.vendor_invoices vi
          where vi.company_id = $1
            and vi.status::text = 'posted'
            and abs(vi.grand_total::numeric - $2::numeric) < 0.01
            and not exists (
              select 1
                from public.bank_reconciliation_matches brm
               where brm.candidate_type = 'vendor_invoice'
                 and brm.candidate_id = vi.id
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

async function matchLocalMutation(
  client: ApprovalClient,
  mutation: MatchingMutation,
  actor: string,
): Promise<"matched" | "manual_review" | "unmatched"> {
  if (mutation.company_id == null) return "unmatched";

  await client.query(
    `delete from public.bank_reconciliation_matches
      where mutation_id = $1
        and status not in ('approved', 'posted')`,
    [mutation.id],
  );

  const candidates = await loadLocalMatchCandidates(client, mutation);
  const best = candidates[0];
  const isDuplicate = candidates.length > 1 && candidates[1]!.score >= best!.score - 5;
  const nextStatus = !best
    ? "unmatched"
    : isDuplicate
      ? "duplicate_need_review"
      : best.score >= 80
        ? "matched"
        : "manual_review";

  if (best) {
    await client.query(
      `insert into public.bank_reconciliation_matches
        (mutation_id, candidate_type, candidate_id, match_score, match_reason,
         amount_match, date_match, name_match, order_id_match, proof_match, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, 'candidate')`,
      [
        mutation.id,
        best.candidateType,
        best.candidateId,
        Math.round(best.score),
        isDuplicate ? "Lebih dari satu kandidat memiliki kecocokan serupa." : best.reason,
        best.amountMatch,
        best.dateMatch,
        best.nameMatch,
        best.referenceMatch,
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
      nextStatus === "matched" ? "matched" : nextStatus,
      best ? (isDuplicate ? "Kandidat ganda perlu diperiksa." : best.reason) : null,
      best ? (isDuplicate ? "DUPLICATE_CANDIDATE" : "LOCAL_MATCHING") : null,
      mutation.id,
    ],
  );

  await client.query(
    `insert into public.bank_reconciliation_audit
      (mutation_id, action, actor, meta)
     values ($1, 'MATCH_CREATED', $2, $3::jsonb)`,
    [
      mutation.id,
      actor,
      JSON.stringify({
        engine: "bizportal-local-matching",
        candidate_count: candidates.length,
        candidate_type: best?.candidateType ?? null,
        candidate_id: best?.candidateId ?? null,
        score: best?.score ?? null,
        status: nextStatus,
      }),
    ],
  );

  return nextStatus === "duplicate_need_review" ? "manual_review" : nextStatus;
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
  }

  const client = await pool.connect();
  try {
    const result = await client.query<MatchingMutation>(
      `select bm.id, bm.amount, bm.direction, bm.transaction_date,
              bm.description, bm.normalized_description, bm.provider_order_id,
              bm.company_id, bm.status
         from public.bank_mutations bm
        where ${filters.join(" and ")}
        order by bm.transaction_date desc, bm.id
        limit 500`,
      values as any[],
    );

    let processed = 0;
    let autoMatched = 0;
    let manualReview = 0;
    let unmatched = 0;
    let failed = 0;

    for (const mutation of result.rows) {
      try {
        await client.query("begin");
        const outcome = await matchLocalMutation(client, mutation, actor.email);
        await client.query("commit");
        processed++;
        if (outcome === "matched") autoMatched++;
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
      manual_review: manualReview,
      unmatched,
      rule_matched: 0,
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
  const isVendorPayable = type.includes("vendor") || type.includes("invoice") || type.includes("payable");
  const configuredId = direction === "IN"
    ? configured?.ar_account_id
    : isVendorPayable
      ? configured?.ap_account_id
      : configured?.purchase_expense_account_id ?? configured?.ap_account_id;

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
    `select id, status, amount, direction, transaction_date, description,
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
    if (mutation.journal_entry_id == null) {
      throw new ApprovalError("Mutasi sudah approved tetapi belum memiliki jurnal.", 409, "APPROVAL_STATE_INVALID");
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
    selectedCandidateSource = requestedSource ?? match.candidate_source;
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
  const contra = await resolveApprovalContraAccount(
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
    const txDate = String(mutation.transaction_date).split("T")[0];
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

    const lineDescription = (note ?? description ?? `Rekon ${mutationId}`).slice(0, 200);
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
            updated_at = now()
      where id = $3`,
    [entryId, actor.email, mutationId],
  );

  if (matchId != null) {
    await client.query(
      `update public.bank_reconciliation_matches
          set status = 'approved'
        where id = $1 and mutation_id = $2`,
      [matchId, mutationId],
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
        ...(error.code === "JOURNAL_MAPPING_REQUIRED" || error.code === "COA_NOT_FOUND"
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

    req.log.error({ error, mutationId }, "Bank reconciliation approval failed");
    res.status(503).json({ error: "Approval mutasi dan pembuatan draft jurnal gagal" });
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
    ]);
    if (!resettableStatuses.has(status)) {
      const message =
        status === "posted"
          ? "Mutasi sudah posted. Gunakan alur Unmatch & Reverse agar ledger tetap immutable."
          : status === "approved_pending_posting" || status === "approved"
            ? "Mutasi masih memiliki draft approval. Gunakan Batalkan Draft terlebih dahulu."
            : `Mutasi berstatus '${mutation.status}' tidak dapat di-unmatch melalui alur ini.`;
      const error = new Error(message) as Error & { code?: string };
      error.code = "INVALID_STATUS";
      throw error;
    }

    let removedDraftJournalId: number | null = null;
    if (mutation.journal_entry_id !== null) {
      const journalStatus = String(mutation.journal_status ?? "").toLowerCase();
      if (journalStatus === "draft") {
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
    if (!MUTATION_STATUSES.has(status)) throw new Error("INVALID_STATUS");
    values.push(status);
    filters.push(`bm.status = $${values.length}`);
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
      'order_ref', match.order_ref
    ) order by match.match_score desc nulls last, match.id), '[]'::json)
    from public.bank_reconciliation_matches match
    where match.mutation_id = bm.id
  ) as candidates,
  exists (
    select 1
    from public.bank_reconciliation_matches approved_match
    where approved_match.mutation_id = bm.id
      and approved_match.status = 'approved'
  ) as has_approved_match,
  (
    select coalesce(json_agg(json_build_object(
      'id', qris.id,
      'mutation_id', qris.mutation_id,
      'company_id', qris.company_id,
      'provider_code', qris.provider_code,
      'mutation_source_classification', qris.mutation_source_classification,
      'source_date', qris.source_date,
      'estimated_settlement_date', qris.estimated_settlement_date,
      'gross_amount', qris.gross_amount,
      'net_amount', qris.net_amount,
      'observed_deduction', qris.observed_deduction,
      'effective_deduction_rate', qris.effective_deduction_rate,
      'reconciliation_status', qris.reconciliation_status,
      'confidence', qris.confidence,
      'review_reason', qris.review_reason,
      'payment_items', qris.payment_items,
      'candidate_source', qris.candidate_source,
      'status', qris.status,
      'auto_post_status', qris.auto_post_status,
      'auto_post_stage', qris.auto_post_stage,
      'auto_post_problem', qris.auto_post_problem,
      'auto_post_revision', qris.auto_post_revision,
      'auto_post_action', qris.auto_post_action,
      'auto_post_details', qris.auto_post_details
    ) order by qris.updated_at desc nulls last, qris.id desc), '[]'::json)
    from public.qris_mutation_batch_candidates qris
    where qris.mutation_id = bm.id
      and lower(coalesce(qris.status, '')) in (
        'candidate_auto_matched',
        'candidate_review',
        'approved',
        'partial',
        'completed'
      )
  ) as qris_candidate_audits,
  (
    select json_build_object(
      'id', qris.id,
      'mutation_id', qris.mutation_id,
      'company_id', qris.company_id,
      'provider_code', qris.provider_code,
      'mutation_source_classification', qris.mutation_source_classification,
      'source_date', qris.source_date,
      'estimated_settlement_date', qris.estimated_settlement_date,
      'gross_amount', qris.gross_amount,
      'net_amount', qris.net_amount,
      'observed_deduction', qris.observed_deduction,
      'effective_deduction_rate', qris.effective_deduction_rate,
      'reconciliation_status', qris.reconciliation_status,
      'confidence', qris.confidence,
      'review_reason', qris.review_reason,
      'payment_items', qris.payment_items,
      'candidate_source', qris.candidate_source,
      'status', qris.status,
      'auto_post_status', qris.auto_post_status,
      'auto_post_stage', qris.auto_post_stage,
      'auto_post_problem', qris.auto_post_problem,
      'auto_post_revision', qris.auto_post_revision,
      'auto_post_action', qris.auto_post_action,
      'auto_post_details', qris.auto_post_details
    )
    from public.qris_mutation_batch_candidates qris
    where qris.mutation_id = bm.id
      and lower(coalesce(qris.status, '')) in (
        'candidate_auto_matched',
        'candidate_review',
        'approved',
        'partial',
        'completed'
      )
    order by qris.updated_at desc nulls last, qris.id desc
    limit 1
  ) as qris_candidate_audit
`;

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
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 500)
      : 100;
    const includeCompleted = String(queryString(req.query.includeCompleted) ?? "")
      .toLowerCase() === "true";
    const requestedStatus = String(queryString(req.query.status) ?? "ALL").toUpperCase();
    const values: unknown[] = [];
    const filters = ["true"];
    if (companyId !== null) {
      values.push(companyId);
      filters.push(`qris.company_id = $${values.length}`);
    }
    if (requestedStatus !== "ALL") {
      const allowedStatuses = new Set(["MATCHED", "REVIEW", "UNMATCHED", "APPROVED", "RECONCILED"]);
      if (!allowedStatuses.has(requestedStatus)) {
        res.status(400).json({ error: "Status kandidat QRIS tidak valid", code: "INVALID_QRIS_STATUS" });
        return;
      }
      values.push(requestedStatus);
      filters.push(`upper(coalesce(qris.reconciliation_status, '')) = $${values.length}`);
    }
    if (!includeCompleted) {
      filters.push(`lower(coalesce(qris.status, '')) not in ('approved', 'completed', 'superseded', 'stale')`);
    }
    values.push(limit);

    const result = await pool.query(
      `select ${qrisCandidateColumns}
         from public.qris_mutation_batch_candidates qris
        where ${filters.join(" and ")}
        order by qris.source_date desc nulls last, qris.updated_at desc nulls last, qris.id desc
        limit $${values.length}`,
      values,
    );

    let canonicalSettlements: Record<string, unknown>[] = [];
    try {
      canonicalSettlements = await listQrisCanonicalSettlements(
        companyId,
        includeCompleted,
        limit,
      );
    } catch (error) {
      // Older local databases can have the provisional candidate table before
      // the canonical queue view. Candidate review must still be available;
      // the queue is additive display data, never an approval fallback.
      req.log.warn({ error }, "Canonical QRIS settlement queue unavailable");
    }

    res.json({
      mode: "local_qris_candidate_review",
      automaticFinalReconciliation: false,
      automaticMatch: false,
      canonicalSettlements,
      candidates: result.rows.map((row) => qrisCandidateResponse(row)),
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    req.log.error({ error }, "Failed to load local QRIS candidates");
    res.status(code === "42P01" ? 503 : 500).json({
      error: code === "42P01"
        ? "Schema kandidat QRIS lokal belum tersedia."
        : "Kandidat QRIS tidak dapat dimuat",
      code: code === "42P01" ? "QRIS_SCHEMA_UNAVAILABLE" : "QRIS_CANDIDATES_UNAVAILABLE",
    });
  }
});

router.post("/bank-reconciliation/qris-candidates/generate", async (req, res): Promise<void> => {
  let actor: ApprovalActor | null;
  try {
    actor = await getApprovalActor(req);
  } catch (error) {
    req.log.error({ error }, "Failed to resolve QRIS generation actor");
    res.status(503).json({ error: "Authorization service unavailable" });
    return;
  }
  if (!actor) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const rawCompanyId = req.body?.companyId ?? req.body?.company_id ?? actor.companyId;
  const companyId = rawCompanyId == null || rawCompanyId === "" ? null : safeInteger(rawCompanyId);
  const rawMutationId = req.body?.mutationId ?? req.body?.mutation_id;
  const mutationId = rawMutationId == null || rawMutationId === "" ? null : safeInteger(rawMutationId);
  if (rawCompanyId != null && companyId == null) {
    res.status(400).json({ error: "companyId tidak valid", code: "INVALID_COMPANY_ID" });
    return;
  }
  if (rawMutationId != null && mutationId == null) {
    res.status(400).json({ error: "mutationId kandidat QRIS tidak valid", code: "INVALID_QRIS_MUTATION_ID" });
    return;
  }
  if (actor.companyId != null && companyId != null && actor.companyId !== companyId) {
    res.status(403).json({ error: "Company context tidak sesuai", code: "COMPANY_CONTEXT_MISMATCH" });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const mutationResult = await client.query<{
      id: number;
      company_id: number | null;
      transaction_date: string;
      amount: string;
      description: string | null;
      provider_name: string | null;
      bank_account_id: number | null;
    }>(
      `select id, company_id, transaction_date, amount, description, provider_name, bank_account_id
         from public.bank_mutations
        where ($1::int is null or company_id = $1)
          and ($2::int is null or id = $2)
          and upper(direction) = 'IN'
          and (
            lower(coalesce(provider_name, '')) like '%qris%'
            or lower(coalesce(description, '')) like '%qris%'
            or lower(coalesce(description, '')) like '%paylabs%'
          )
        order by transaction_date desc, id desc
        limit 500
        for update`,
      [companyId, mutationId],
    );

    const generated: Record<string, unknown>[] = [];
    for (const mutation of mutationResult.rows) {
      const paymentResult = await client.query(
        `select
           sp.id,
           sp.amount,
           sp.status,
           sp.paid_at,
           sp.payment_number,
           sp.method,
           coalesce(
             nullif(to_jsonb(sp)->>'provider_name', ''),
             nullif(to_jsonb(sp)->>'provider', '')
           ) as provider_name,
           case
             when coalesce(to_jsonb(sp)->>'mdr_amount', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
               then (to_jsonb(sp)->>'mdr_amount')::numeric
             else 0
           end as mdr_amount
         from public.sport_payments sp
        where sp.company_id = $1
          and lower(coalesce(sp.method, '')) like '%qris%'
          and lower(coalesce(sp.status, '')) = 'confirmed'
          and sp.paid_at::date = $2::date - 1
        order by sp.id`,
        [mutation.company_id, mutation.transaction_date],
      );
      const payments = paymentResult.rows;
      const grossAmount = payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
      const mdrAmount = payments.reduce((sum, payment) => sum + Number(payment.mdr_amount || 0), 0);
      const netAmount = Number(mutation.amount);
      const difference = Math.abs(grossAmount - mdrAmount - netAmount);
      const status = payments.length === 0
        ? "UNMATCHED"
        : difference <= 0.5 ? "MATCHED" : "REVIEW";
      const candidateStatus = status === "MATCHED" ? "candidate_auto_matched" : "candidate_review";
      const paymentItems = payments.map((payment) => ({
        paymentId: Number(payment.id),
        grossAmount: Number(payment.amount),
        paymentStatus: payment.status,
        settlementStatus: "unsettled",
        providerName: payment.provider_name,
        paymentNumber: payment.payment_number,
        paidAt: payment.paid_at,
        expectedSettlementDate: mutation.transaction_date,
      }));
      const reviewReason = payments.length === 0
        ? "Belum ditemukan payment QRIS confirmed dengan paid_at H-1."
        : status === "MATCHED"
          ? "Gross payment dikurangi MDR sesuai dengan nominal mutasi bank."
          : `Selisih gross dikurangi MDR dengan mutasi bank: ${difference.toFixed(2)}.`;

      const existing = await client.query<{ id: number; status: string }>(
        `select id, status
           from public.qris_mutation_batch_candidates
          where mutation_id = $1
          order by id desc
          limit 1
          for update`,
        [mutation.id],
      );
      const existingRow = existing.rows[0];
      if (existingRow && ["approved", "completed"].includes(String(existingRow.status).toLowerCase())) {
        generated.push({ id: existingRow.id, mutation_id: mutation.id, status: existingRow.status });
        continue;
      }

      const values = [
        mutation.id,
        mutation.company_id,
        mutation.bank_account_id,
        mutation.transaction_date,
        mutation.transaction_date,
        "unknown",
        "payment_source",
        "payment-method-h-minus-one-v1",
        "actual_bank_mutation",
        grossAmount,
        mdrAmount,
        netAmount,
        JSON.stringify(paymentItems),
        candidateStatus,
        status,
        payments.length > 0 && difference <= 0.5 ? 1 : payments.length > 0 ? 0.6 : 0,
        Math.max(0, grossAmount - mdrAmount),
        grossAmount > 0 ? mdrAmount / grossAmount : null,
        reviewReason,
      ];
      let saved;
      if (existingRow) {
        saved = await client.query(
          `update public.qris_mutation_batch_candidates
              set company_id = $2,
                  bank_account_id = $3,
                  source_date = $4,
                  estimated_settlement_date = $5,
                  provider_code = $6,
                  provider_detection_source = $7,
                  settlement_rule_version = $8,
                  mutation_source_classification = $9,
                  gross_amount = $10,
                  mdr_amount = $11,
                  net_amount = $12,
                  payment_items = $13::jsonb,
                  status = $14,
                  reconciliation_status = $15,
                  confidence = $16,
                  observed_deduction = $17,
                  effective_deduction_rate = $18,
                  review_reason = $19,
                  generated_at = now(),
                  updated_at = now()
            where id = $1
          returning id, mutation_id, status, reconciliation_status`,
          [existingRow.id, ...values.slice(1)],
        );
      } else {
        saved = await client.query(
          `insert into public.qris_mutation_batch_candidates
            (mutation_id, company_id, bank_account_id, source_date,
             estimated_settlement_date, provider_code, provider_detection_source,
             settlement_rule_version, mutation_source_classification,
             gross_amount, mdr_amount, net_amount, payment_items, status,
             reconciliation_status, confidence, observed_deduction,
             effective_deduction_rate, review_reason)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13::jsonb, $14, $15, $16, $17, $18, $19)
           returning id, mutation_id, status, reconciliation_status`,
          values,
        );
      }
      generated.push(saved.rows[0] ?? { mutation_id: mutation.id, status });
    }
    await client.query("commit");
    res.json({
      ok: true,
      mode: "strict_h_minus_one_local",
      generated: generated.length,
      persisted: generated.length,
      reviewable: generated.filter((candidate) =>
        ["MATCHED", "REVIEW"].includes(String(candidate.reconciliation_status)),
      ).length,
      candidates: generated,
      actor: actor.email,
    });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    const code = (error as { code?: string }).code;
    req.log.error({ error }, "Failed to generate local QRIS candidates");
    res.status(code === "42P01" ? 503 : 500).json({
      error: code === "42P01" ? "Schema kandidat QRIS lokal belum tersedia." : "Kandidat QRIS tidak dapat dibuat",
      code: code === "42P01" ? "QRIS_SCHEMA_UNAVAILABLE" : "QRIS_CANDIDATE_GENERATION_FAILED",
    });
  } finally {
    client.release();
  }
});

router.post("/bank-reconciliation/qris-candidates/:candidateId/approve", async (req, res): Promise<void> => {
  const candidateId = parsePositiveInt(req.params.candidateId);
  if (candidateId === null) {
    res.status(400).json({ error: "candidateId tidak valid", code: "INVALID_CANDIDATE_ID" });
    return;
  }

  let actor: ApprovalActor | null;
  try {
    actor = await getApprovalActor(req);
  } catch (error) {
    req.log.error({ error }, "Failed to resolve QRIS approval actor");
    res.status(503).json({ error: "Authorization service unavailable" });
    return;
  }
  if (!actor) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const requestedMutationId = safeInteger(req.body?.mutationId ?? req.body?.mutation_id);
  const requestedCompanyId = safeInteger(req.body?.companyId ?? req.body?.company_id);
  const paymentIdsInput = Array.isArray(req.body?.paymentIds) ? req.body.paymentIds : null;
  const manualOverride = req.body?.manual_override === true;
  const overrideReason = textValue(req.body?.override_reason);
  if (paymentIdsInput?.some((value: unknown) => safeInteger(value) === null)) {
    res.status(422).json({ error: "Payment ID kandidat QRIS tidak valid", code: "INVALID_PAYMENT_SCOPE" });
    return;
  }
  if (manualOverride && (!overrideReason || overrideReason.length < 10)) {
    res.status(422).json({
      error: "Alasan manual override minimal 10 karakter.",
      code: "MANUAL_OVERRIDE_REASON_REQUIRED",
    });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const candidateResult = await client.query<{
      id: number;
      mutation_id: number;
      company_id: number | null;
      status: string | null;
      reconciliation_status: string | null;
      net_amount: string | null;
      observed_deduction: string | null;
      payment_items: unknown;
      mutation_status: string;
      mutation_amount: string;
      mutation_direction: string;
      mutation_company_id: number | null;
      mutation_journal_entry_id: number | null;
    }>(
      `select qris.id,
              qris.mutation_id,
              qris.company_id,
              qris.status,
              qris.reconciliation_status,
              qris.net_amount,
              qris.observed_deduction,
              qris.payment_items,
              bm.status as mutation_status,
              bm.amount as mutation_amount,
              bm.direction as mutation_direction,
              bm.company_id as mutation_company_id,
              bm.journal_entry_id as mutation_journal_entry_id
         from public.qris_mutation_batch_candidates qris
         join public.bank_mutations bm on bm.id = qris.mutation_id
        where qris.id = $1
        for update of qris, bm`,
      [candidateId],
    );
    const candidate = candidateResult.rows[0];
    if (!candidate) {
      throw new ApprovalError("Kandidat QRIS tidak ditemukan.", 404, "NOT_FOUND");
    }
    if (requestedMutationId != null && requestedMutationId !== candidate.mutation_id) {
      throw new ApprovalError("Kandidat QRIS bukan milik mutasi yang dikirim.", 409, "MUTATION_SCOPE_MISMATCH");
    }
    if (requestedCompanyId != null && requestedCompanyId !== candidate.company_id) {
      throw new ApprovalError("Kandidat QRIS bukan milik company yang dikirim.", 403, "COMPANY_SCOPE_FORBIDDEN");
    }
    if (candidate.company_id == null || candidate.mutation_company_id !== candidate.company_id) {
      throw new ApprovalError("Kandidat QRIS tidak memiliki company scope yang valid.", 422, "COMPANY_SCOPE_REQUIRED");
    }
    if (actor.companyId != null && actor.companyId !== candidate.company_id) {
      throw new ApprovalError("Kandidat QRIS berada di perusahaan yang berbeda.", 403, "COMPANY_SCOPE_FORBIDDEN");
    }
    if (String(candidate.mutation_direction).toUpperCase() !== "IN") {
      throw new ApprovalError("Settlement QRIS hanya dapat ditautkan ke mutasi IN.", 422, "INVALID_DIRECTION");
    }
    if (["approved", "completed"].includes(String(candidate.status ?? "").toLowerCase())) {
      if (candidate.mutation_journal_entry_id == null) {
        throw new ApprovalError("Kandidat sudah approved tetapi jurnal mutasi belum tersedia.", 409, "APPROVAL_STATE_INVALID");
      }
      await client.query("commit");
      res.json({
        ok: true,
        candidateId,
        mutationId: candidate.mutation_id,
        journal_entry_id: candidate.mutation_journal_entry_id,
        idempotent: true,
      });
      return;
    }

    const reconciliationStatus = String(candidate.reconciliation_status ?? "").toUpperCase();
    if (reconciliationStatus !== "MATCHED" && !manualOverride) {
      throw new ApprovalError(
        "Kandidat QRIS belum MATCHED. Review manual wajib memiliki override eksplisit.",
        422,
        "CANDIDATE_NOT_ELIGIBLE",
      );
    }

    const rawItems = Array.isArray(candidate.payment_items) ? candidate.payment_items : [];
    const itemIds = rawItems
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const value = item as Record<string, unknown>;
        return safeInteger(value.paymentId ?? value.payment_id);
      })
      .filter((id): id is number => id != null);
    if (itemIds.length === 0 || new Set(itemIds).size !== itemIds.length) {
      throw new ApprovalError("Kandidat QRIS tidak memiliki payment scope yang valid.", 422, "INVALID_PAYMENT_SCOPE");
    }
    const requestedPaymentIds: number[] = (paymentIdsInput ?? itemIds)
      .map((value: unknown) => safeInteger(value)!)
      .sort((a: number, b: number) => a - b);
    const expectedPaymentIds = [...itemIds].sort((a: number, b: number) => a - b);
    if (
      requestedPaymentIds.length !== expectedPaymentIds.length
      || requestedPaymentIds.some((id: number, index: number) => id !== expectedPaymentIds[index])
    ) {
      throw new ApprovalError(
        "Approval QRIS parsial diblokir sampai settlement canonical menyediakan scope parsial.",
        409,
        "CANONICAL_SETTLEMENT_SELECTION_CONFLICT",
      );
    }

    const candidateNet = Number(candidate.net_amount);
    const mutationAmount = Number(candidate.mutation_amount);
    if (
      !Number.isFinite(candidateNet)
      || !Number.isFinite(mutationAmount)
      || candidateNet < 0
      || Math.abs(candidateNet - mutationAmount) > 0.5
    ) {
      throw new ApprovalError(
        "Nominal kandidat QRIS tidak sama dengan nominal mutasi bank.",
        422,
        "AMOUNT_MISMATCH",
      );
    }

    const approval = await approveBankMutation(
      client,
      candidate.mutation_id,
      {
        candidate_type: "qris_settlement",
        candidate_id: candidateId,
        candidate_source: "local.qris_mutation_batch_candidates",
        note: manualOverride ? overrideReason : "QRIS candidate MATCHED",
      },
      actor,
      textValue(req.header("x-idempotency-key")),
    );
    await client.query(
      `update public.qris_mutation_batch_candidates
          set status = 'approved',
              reconciliation_status = 'MATCHED',
              review_reason = $2,
              updated_at = now()
        where id = $1`,
      [candidateId, manualOverride ? overrideReason : "Kandidat QRIS disetujui melalui approval lokal."],
    );
    await client.query("commit");
    res.status(201).json({
      ok: true,
      candidateId,
      mutationId: candidate.mutation_id,
      itemCount: itemIds.length,
      partial: false,
      ...approval,
    });
  } catch (error) {
    await client.query("rollback").catch((rollbackError) => {
      req.log.warn({ rollbackError }, "QRIS approval rollback failed");
    });
    if (error instanceof ApprovalError) {
      res.status(error.status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.code === "JOURNAL_MAPPING_REQUIRED" || error.code === "COA_NOT_FOUND"
          ? { manual_review_required: true }
          : {}),
      });
      return;
    }
    const code = (error as { code?: string }).code;
    req.log.error({ error, candidateId }, "Local QRIS candidate approval failed");
    res.status(code === "42P01" ? 503 : 500).json({
      error: code === "42P01"
        ? "Schema kandidat QRIS lokal belum tersedia."
        : "Approval kandidat QRIS gagal",
      code: code === "42P01" ? "QRIS_SCHEMA_UNAVAILABLE" : "QRIS_APPROVAL_FAILED",
    });
  } finally {
    client.release();
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
    if (message === "INVALID_STATUS" || message === "INVALID_DIRECTION") {
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
    if (message === "INVALID_STATUS" || message === "INVALID_DIRECTION") {
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
           and lower(coalesce(pmg.status, '')) in ('posted', 'reconciled')
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