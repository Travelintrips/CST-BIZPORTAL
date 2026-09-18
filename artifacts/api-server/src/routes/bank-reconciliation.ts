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
  ) as has_approved_match
`;

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