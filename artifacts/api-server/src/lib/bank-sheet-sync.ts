import crypto from "node:crypto";
import { pool } from "@workspace/db";
import {
  readSpreadsheetValues,
  spreadsheetCellRange,
  writeSpreadsheetValues,
  type SpreadsheetValueUpdate,
} from "./google-sheets";

type SheetConfig = {
  id: number;
  company_id: number | null;
  sheet_id: string;
  tab_name: string;
  label: string;
  bank_account_number: string | null;
};

type ParsedMutation = {
  rowNumber: number;
  transactionDate: string;
  description: string;
  debit: number;
  credit: number;
  amount: number;
  direction: "IN" | "OUT";
  bank: string | null;
  mutationKey: string | null;
  sheetStatus: string | null;
};

type ExistingMutation = {
  id: number;
  mutation_key: string | null;
  canonical_key: string | null;
  status: string | null;
  reconciliation_status: string | null;
  journal_entry_id: number | null;
  match_score: number | null;
  match_reason: string | null;
  match_status: string | null;
  match_result: string | null;
  coa_code: string | null;
  coa_name: string | null;
};

type SheetMutationMetadata = {
  key: string;
  status: string;
  coaCode: string | null;
  coaName: string | null;
  matchScore: number | null;
  matchResult: string | null;
  lastSync: string;
};

function normalizeDescription(value: string): string {
  return value
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/[^A-Z0-9 ]/g, "")
    .trim();
}

function canonicalKey(
  row: ParsedMutation,
  companyId: number | null,
  bankAccountId: number | null,
): string {
  const payload = [
    companyId ?? 0,
    bankAccountId ?? 0,
    row.transactionDate,
    Math.round(Math.abs(row.debit) * 100),
    Math.round(Math.abs(row.credit) * 100),
    normalizeDescription(row.description),
  ].join("|");
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

function normalizeMutationKey(value: string): string | null {
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function parseAmount(value: string): number {
  const cleaned = String(value ?? "").replace(/[^0-9.,-]/g, "").trim();
  if (!cleaned) return 0;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const decimalIndex = Math.max(lastComma, lastDot);
    const fractionalDigits = cleaned.length - decimalIndex - 1;
    if (fractionalDigits <= 2) {
      const integerPart = cleaned.slice(0, decimalIndex).replace(/[.,]/g, "");
      const fractionPart = cleaned.slice(decimalIndex + 1).replace(/[.,]/g, "");
      normalized = `${integerPart}.${fractionPart}`;
    } else {
      normalized = cleaned.replace(/[.,]/g, "");
    }
  } else if (lastComma >= 0) {
    const fractionalDigits = cleaned.length - lastComma - 1;
    normalized = fractionalDigits === 1 || fractionalDigits === 2
      ? cleaned.replace(",", ".")
      : cleaned.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const fractionalDigits = cleaned.length - lastDot - 1;
    normalized = fractionalDigits === 3
      ? cleaned.replace(/\./g, "")
      : cleaned;
  }

  return Math.abs(Number.parseFloat(normalized) || 0);
}

const MONTHS: Record<string, number> = {
  januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6,
  juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, agu: 8, ags: 8,
  sep: 9, okt: 10, nov: 11, des: 12,
};

function parseDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const mdy = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const [, month, day, year] = mdy;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (!Number.isNaN(date.getTime())) {
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
  }

  const dmy = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmy) {
    const [, day, month, year] = dmy;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (!Number.isNaN(date.getTime())) {
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
  }

  const textDate = value.match(/^(\d{1,2})[\s-]+([a-zA-Z]+)[\s-]+(\d{4})$/);
  if (textDate) {
    const [, day, monthName, year] = textDate;
    const month = MONTHS[monthName.toLowerCase()];
    if (month) return `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const serial = Number(value);
  if (Number.isInteger(serial) && serial > 1000 && serial < 100000) {
    const epoch = Date.UTC(1899, 11, 30);
    const date = new Date(epoch + serial * 86_400_000);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function findColumn(headers: string[], candidates: string[]): number {
  const normalized = headers.map((header) => header.trim().toLowerCase());
  for (const candidate of candidates) {
    const exact = normalized.findIndex((header) => header === candidate);
    if (exact >= 0) return exact;
  }
  for (const candidate of candidates) {
    const partial = normalized.findIndex((header) => header.includes(candidate));
    if (partial >= 0) return partial;
  }
  return -1;
}

function statusLabel(mutation: {
  status: string | null;
  reconciliation_status: string | null;
}): string {
  const reconciliationStatus = String(mutation.reconciliation_status ?? "").toLowerCase();
  const status = String(mutation.status ?? "").toLowerCase();
  if (reconciliationStatus === "reconciled") return "RECONCILED";
  if (reconciliationStatus === "posted" || status === "posted") return "POSTED";
  if (["approved", "approved_pending_posting"].includes(status)) return "APPROVED";
  if (reconciliationStatus === "matched" || status === "matched") return "MATCHED";
  if (["void", "voided"].includes(status)) return "VOID";
  return "UNMATCHED";
}

function parseRows(rows: string[][]): {
  mutations: ParsedMutation[];
  headers: string[];
  keyColumn: number;
  statusColumn: number;
  coaCodeColumn: number;
  coaNameColumn: number;
  matchScoreColumn: number;
  matchResultColumn: number;
  lastSyncColumn: number;
  headerRow: number;
} {
  if (rows.length < 2) {
    return {
      mutations: [],
      headers: rows[0] ?? [],
      keyColumn: -1,
      statusColumn: -1,
      coaCodeColumn: -1,
      coaNameColumn: -1,
      matchScoreColumn: -1,
      matchResultColumn: -1,
      lastSyncColumn: -1,
      headerRow: rows.length === 1 ? 1 : 0,
    };
  }
  const headers = rows[0] ?? [];
  let dateColumn = findColumn(headers, ["tanggal", "tgl", "date", "waktu", "time"]);
  let descriptionColumn = findColumn(headers, [
    "keterangan", "narasi", "description", "desc", "berita", "remark", "info",
  ]);
  let creditColumn = findColumn(headers, ["kredit", "credit", "masuk", "cr", "jumlah masuk"]);
  let debitColumn = findColumn(headers, ["debit", "debet", "keluar", "db", "out", "jumlah keluar"]);
  const bankColumn = findColumn(headers, ["bank", "rekening", "akun"]);
  let keyColumn = findColumn(headers, [
    "mutation_key",
    "mutation key",
    "mutation id",
    "id mutasi",
    "kunci mutasi",
  ]);
  let statusColumn = findColumn(headers, [
    "status_recon",
    "status recon",
    "status rekonsiliasi",
    "reconciliation status",
    "status",
  ]);
  let coaCodeColumn = findColumn(headers, ["coa_code", "kode coa", "coa"]);
  let coaNameColumn = findColumn(headers, ["nama_coa", "nama coa", "coa name"]);
  let matchScoreColumn = findColumn(headers, ["match_score", "match score", "confidence score"]);
  let matchResultColumn = findColumn(headers, ["match_result", "match result", "hasil match"]);
  let lastSyncColumn = findColumn(headers, ["last_sync", "last sync", "last synced", "sync terakhir"]);
  let start = 1;
  let headerRow = 1;

  if (dateColumn < 0 && descriptionColumn < 0 && creditColumn < 0 && debitColumn < 0) {
    const firstData = rows.findIndex((row) => parseDate(String(row[0] ?? "")) !== null);
    if (firstData >= 0) {
      start = firstData;
      headerRow = 0;
      dateColumn = 0;
      descriptionColumn = 1;
      debitColumn = 2;
      creditColumn = 3;
      keyColumn = -1;
      statusColumn = -1;
      coaCodeColumn = -1;
      coaNameColumn = -1;
      matchScoreColumn = -1;
      matchResultColumn = -1;
      lastSyncColumn = -1;
    }
  }

  const result: ParsedMutation[] = [];
  for (const [offset, row] of rows.slice(start).entries()) {
    if (!row?.some((cell) => String(cell ?? "").trim())) continue;
    const date = parseDate(String(row[dateColumn] ?? ""));
    const debit = parseAmount(String(row[debitColumn] ?? ""));
    const credit = parseAmount(String(row[creditColumn] ?? ""));
    const amount = credit || debit;
    if (!date || amount <= 0) continue;
    result.push({
      rowNumber: start + offset + 1,
      transactionDate: date,
      description: String(row[descriptionColumn] ?? "").trim(),
      debit,
      credit,
      amount,
      direction: debit > 0 && credit <= 0 ? "OUT" : "IN",
      bank: bankColumn >= 0 ? String(row[bankColumn] ?? "").trim() || null : null,
      mutationKey:
        keyColumn >= 0 ? normalizeMutationKey(String(row[keyColumn] ?? "")) : null,
      sheetStatus:
        statusColumn >= 0 ? String(row[statusColumn] ?? "").trim() || null : null,
    });
  }
  return {
    mutations: result,
    headers,
    keyColumn,
    statusColumn,
    coaCodeColumn,
    coaNameColumn,
    matchScoreColumn,
    matchResultColumn,
    lastSyncColumn,
    headerRow,
  };
}

function addSheetStatusUpdates(
  config: SheetConfig,
  parsed: ReturnType<typeof parseRows>,
  mutationStatuses: Map<number, SheetMutationMetadata>,
): SpreadsheetValueUpdate[] {
  if (parsed.mutations.length === 0) return [];

  let keyColumn = parsed.keyColumn;
  let statusColumn = parsed.statusColumn;
  const updates: SpreadsheetValueUpdate[] = [];
  let nextColumn = parsed.headers.length;

  if (keyColumn < 0 && parsed.headerRow > 0) {
    keyColumn = nextColumn++;
    updates.push({
      range: spreadsheetCellRange(config.tab_name, keyColumn, parsed.headerRow),
      values: [["mutation_key"]],
    });
  }
  if (statusColumn < 0 && parsed.headerRow > 0) {
    statusColumn = nextColumn++;
    updates.push({
      range: spreadsheetCellRange(config.tab_name, statusColumn, parsed.headerRow),
      values: [["status_recon"]],
    });
  }
  const metadataColumns = [
    ["coaCodeColumn", "coa"],
    ["coaNameColumn", "nama_coa"],
    ["matchScoreColumn", "match_score"],
    ["matchResultColumn", "match_result"],
    ["lastSyncColumn", "last_sync"],
  ] as const;
  const resolvedColumns = new Map<string, number>();
  for (const [property, header] of metadataColumns) {
    const current = parsed[property];
    if (current >= 0) {
      resolvedColumns.set(property, current);
    } else if (parsed.headerRow > 0) {
      const column = nextColumn++;
      resolvedColumns.set(property, column);
      updates.push({
        range: spreadsheetCellRange(config.tab_name, column, parsed.headerRow),
        values: [[header]],
      });
    }
  }

  if (parsed.headerRow <= 0) return updates;
  for (const row of parsed.mutations) {
    const status = mutationStatuses.get(row.rowNumber);
    if (!status) continue;
    if (keyColumn >= 0) {
      updates.push({
        range: spreadsheetCellRange(config.tab_name, keyColumn, row.rowNumber),
        values: [[status.key]],
      });
    }
    if (statusColumn >= 0) {
      updates.push({
        range: spreadsheetCellRange(config.tab_name, statusColumn, row.rowNumber),
        values: [[status.status]],
      });
    }
    const valuesByColumn = [
      ["coaCodeColumn", status.coaCode ?? ""],
      ["coaNameColumn", status.coaName ?? ""],
      ["matchScoreColumn", status.matchScore == null ? "" : String(status.matchScore)],
      ["matchResultColumn", status.matchResult ?? ""],
      ["lastSyncColumn", status.lastSync],
    ] as const;
    for (const [property, value] of valuesByColumn) {
      const column = resolvedColumns.get(property);
      if (column == null) continue;
      updates.push({
        range: spreadsheetCellRange(config.tab_name, column, row.rowNumber),
        values: [[value]],
      });
    }
  }
  return updates;
}

async function markConfigSync(
  configId: number,
  status: string,
  error: string | null = null,
): Promise<void> {
  await pool.query(
    `update public.bank_sheet_configs
        set last_synced_at = now(), last_sync_status = $1, last_sync_error = $2, updated_at = now()
      where id = $3`,
    [status, error, configId],
  );
}

async function syncConfig(config: SheetConfig): Promise<{
  imported: number;
  total: number;
  existing: number;
  sheetUpdates: number;
}> {
  const client = await pool.connect();
  try {
    const rows = await readSpreadsheetValues(config.sheet_id, config.tab_name);
    const parsed = parseRows(rows);
    if (parsed.mutations.length === 0) {
      await markConfigSync(config.id, "success");
      return {
        imported: 0,
        total: rows.length > 0 ? rows.length - 1 : 0,
        existing: 0,
        sheetUpdates: 0,
      };
    }

    const bankAccount = config.bank_account_number?.trim() || null;
    const prepared = parsed.mutations.map((row) => {
      const generatedKey = canonicalKey(row, config.company_id, null);
      return {
        row,
        key: row.mutationKey ?? generatedKey,
        canonical: generatedKey,
      };
    });
    const mutationKeys = [...new Set(prepared.map((item) => item.key))];
    const canonicalKeys = [...new Set(prepared.map((item) => item.canonical))];
    let imported = 0;
    let existing = 0;
    const lastSync = new Date().toISOString();
    const mutationStatuses = new Map<number, SheetMutationMetadata>();

    const toSheetMetadata = (
      mutation: Partial<ExistingMutation>,
      fallbackKey: string,
    ): SheetMutationMetadata => ({
      key: mutation.mutation_key ?? fallbackKey,
      status: statusLabel(mutation as ExistingMutation),
      coaCode: mutation.coa_code ?? null,
      coaName: mutation.coa_name ?? null,
      matchScore: mutation.match_score == null ? null : Number(mutation.match_score),
      matchResult: mutation.match_result ?? mutation.match_reason ?? null,
      lastSync,
    });

    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `google-sheet-sync:${config.id}`,
    ]);
    const existingResult = await client.query<ExistingMutation>(
      `select bm.id, bm.mutation_key, bm.canonical_key, bm.status,
              bm.reconciliation_status, bm.journal_entry_id,
              matched.match_score,
              matched.match_reason,
              matched.match_status,
              matched.match_result,
              coalesce(contra.coa_code, canonical_contra.coa_code) as coa_code,
              coalesce(contra.coa_name, canonical_contra.coa_name) as coa_name
         from public.bank_mutations bm
         left join lateral (
           select m.match_score,
                  m.match_reason,
                  m.status as match_status,
                  coalesce(
                    nullif(trim(m.match_reason), ''),
                    nullif(concat_ws(' | ', m.candidate_type, m.candidate_id::text, m.status), '')
                  ) as match_result
             from public.bank_reconciliation_matches m
            where m.mutation_id = bm.id
            order by case
              when lower(coalesce(m.status, '')) in ('posted', 'approved', 'reconciled') then 0
              when lower(coalesce(m.status, '')) = 'candidate' then 1
              else 2
            end, m.created_at desc nulls last, m.id desc
            limit 1
         ) matched on true
         left join lateral (
           select coa.code as coa_code, coa.name as coa_name
             from public.accounting_entry_lines line
             join public.chart_of_accounts coa on coa.id = line.account_id
            where line.entry_id = bm.journal_entry_id
              and (
                (upper(coalesce(bm.direction, '')) = 'IN' and coalesce(line.credit, 0) > 0)
                or (upper(coalesce(bm.direction, '')) = 'OUT' and coalesce(line.debit, 0) > 0)
              )
            order by line.id
            limit 1
         ) contra on true
         left join lateral (
           select line.account_code as coa_code,
                  line.account_name as coa_name
             from public.bank_reconciliation_matches match
             join sport_center.payment_settlement_batches batch
               on match.candidate_type = 'qris_settlement'
              and match.candidate_source = 'sport_center.payment_settlement_batches'
              and batch.id = match.candidate_id
             join sport_center.accounting_journals journal
               on journal.id = batch.settlement_journal_id
              and journal.status::text = 'posted'
             join sport_center.accounting_journal_lines line
               on line.journal_id = journal.id
            where match.mutation_id = bm.id
              and lower(coalesce(match.status, '')) in ('approved', 'posted', 'reconciled')
              and batch.status::text in ('reconciled', 'settled', 'completed')
              and coalesce(batch.canonical_bank_mutation_id, batch.bank_mutation_id) = bm.id
              and (
                (upper(coalesce(bm.direction, '')) = 'IN' and lower(coalesce(line.line_type::text, '')) = 'credit')
                or (upper(coalesce(bm.direction, '')) = 'OUT' and lower(coalesce(line.line_type::text, '')) = 'debit')
              )
            order by line.id
            limit 1
         ) canonical_contra on bm.journal_entry_id is null
        where bm.source = 'google_sheet'
          and bm.company_id is not distinct from $1
          and (bm.mutation_key = any($2::text[]) or bm.canonical_key = any($3::text[]))`,
      [config.company_id, mutationKeys, canonicalKeys],
    );
    const byMutationKey = new Map<string, ExistingMutation>();
    const byCanonicalKey = new Map<string, ExistingMutation>();
    for (const mutation of existingResult.rows) {
      if (mutation.mutation_key) byMutationKey.set(mutation.mutation_key, mutation);
      if (mutation.canonical_key) byCanonicalKey.set(mutation.canonical_key, mutation);
    }

    for (const item of prepared) {
      const found = byMutationKey.get(item.key) ?? byCanonicalKey.get(item.canonical);
      if (found) {
        existing += 1;
        mutationStatuses.set(item.row.rowNumber, toSheetMetadata(found, item.key));
        continue;
      }

      const inserted = await client.query<ExistingMutation>(
        `insert into public.bank_mutations
          (mutation_key, canonical_key, transaction_date, description, amount, direction,
           credit_amount, debit_amount, normalized_description, provider_name,
           bank_account_id, source_classification, status, source, source_account,
           company_id, sheet_config_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null,
                 (select id from public.company_bank_accounts
                   where company_id = $10
                     and coalesce(is_active, true) = true
                     and ($11::text is null or account_number = $11)
                   order by id limit 1),
                 'actual_bank_mutation', 'unmatched', 'google_sheet', $12, $10, $13)
         on conflict do nothing
          returning id, mutation_key, canonical_key, status, reconciliation_status, journal_entry_id,
                    null::int as match_score, null::text as match_reason,
                    null::text as match_status, null::text as match_result,
                    null::text as coa_code, null::text as coa_name`,
        [
          item.key,
          item.canonical,
          item.row.transactionDate,
          item.row.description,
          item.row.amount,
          item.row.direction,
          item.row.credit,
          item.row.debit,
          normalizeDescription(item.row.description),
          config.company_id,
          bankAccount,
          item.row.bank,
          config.id,
        ],
      );
      const mutation = inserted.rows[0];
      if (mutation) {
        imported += 1;
        byMutationKey.set(item.key, mutation);
        byCanonicalKey.set(item.canonical, mutation);
        mutationStatuses.set(item.row.rowNumber, toSheetMetadata(mutation, item.key));
      } else {
        existing += 1;
        mutationStatuses.set(item.row.rowNumber, {
          key: item.key,
          status: "UNMATCHED",
          coaCode: null,
          coaName: null,
          matchScore: null,
          matchResult: null,
          lastSync,
        });
      }
    }
    await client.query("commit");

    const sheetUpdates = addSheetStatusUpdates(config, parsed, mutationStatuses);
    try {
      await writeSpreadsheetValues(config.sheet_id, sheetUpdates);
    } catch (sheetError) {
      const message = sheetError instanceof Error ? sheetError.message : String(sheetError);
      await markConfigSync(config.id, "partial", message.slice(0, 500));
      throw new Error(
        `Data tersimpan di database, tetapi status sheet gagal diperbarui: ${message}`,
      );
    }

    await markConfigSync(config.id, "success");
    return {
      imported,
      total: parsed.mutations.length,
      existing,
      sheetUpdates: sheetUpdates.length,
    };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // The transaction may already have been committed or the connection lost.
    }
    const message = error instanceof Error ? error.message : String(error);
    await markConfigSync(config.id, "error", message.slice(0, 500)).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function syncOneBankSheetConfig(configId: number) {
  const result = await pool.query<SheetConfig>(
    `select id, company_id, sheet_id, tab_name, label, bank_account_number
       from public.bank_sheet_configs
      where id = $1 and is_active = true`,
    [configId],
  );
  const config = result.rows[0];
  if (!config) throw new Error("Konfigurasi tidak ditemukan atau tidak aktif");
  const stats = await syncConfig(config);
  return {
    ok: true,
    ...stats,
    message: `Sync 2 arah selesai: ${stats.imported} mutasi baru, ${stats.existing} sudah ada dari ${stats.total} baris; ${stats.sheetUpdates} pembaruan metadata dikirim ke Sheet`,
  };
}

export async function syncAllBankSheetConfigs(companyId?: number) {
  const result = await pool.query<SheetConfig>(
    `select id, company_id, sheet_id, tab_name, label, bank_account_number
       from public.bank_sheet_configs
      where is_active = true
        and ($1::int is null or company_id = $1)
      order by id`,
    [companyId ?? null],
  );
  const summaries: Array<Record<string, unknown>> = [];
  for (const config of result.rows) {
    summaries.push({ label: config.label, ...(await syncConfig(config)) });
  }
  return summaries;
}
