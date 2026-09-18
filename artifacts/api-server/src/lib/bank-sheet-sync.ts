import crypto from "node:crypto";
import { pool } from "@workspace/db";
import { readSpreadsheetValues } from "./google-sheets";

type SheetConfig = {
  id: number;
  company_id: number | null;
  sheet_id: string;
  tab_name: string;
  label: string;
  bank_account_number: string | null;
};

type ParsedMutation = {
  transactionDate: string;
  description: string;
  debit: number;
  credit: number;
  amount: number;
  direction: "IN" | "OUT";
  bank: string | null;
};

function normalizeDescription(value: string): string {
  return value
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/[^A-Z0-9 ]/g, "")
    .trim();
}

function canonicalKey(row: ParsedMutation, companyId: number | null, bankAccountId: number | null): string {
  const payload = [
    companyId ?? 0,
    bankAccountId ?? 0,
    row.transactionDate,
    Math.round(Math.abs(row.debit) * 100),
    Math.round(Math.abs(row.credit) * 100),
    normalizeDescription(row.description),
    "",
  ].join("|");
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

export function parseAmount(value: string): number {
  const cleaned = String(value ?? "").replace(/\s/g, "").replace(/[^0-9.,-]/g, "");
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

function parseRows(rows: string[][]): ParsedMutation[] {
  if (rows.length < 2) return [];
  const headers = rows[0] ?? [];
  let dateColumn = findColumn(headers, ["tanggal", "tgl", "date", "waktu", "time"]);
  let descriptionColumn = findColumn(headers, [
    "keterangan", "narasi", "description", "desc", "berita", "remark", "info",
  ]);
  let creditColumn = findColumn(headers, ["kredit", "credit", "masuk", "cr", "jumlah masuk"]);
  let debitColumn = findColumn(headers, ["debit", "debet", "keluar", "db", "out", "jumlah keluar"]);
  const bankColumn = findColumn(headers, ["bank", "rekening", "akun"]);
  let start = 1;

  if (dateColumn < 0 && descriptionColumn < 0 && creditColumn < 0 && debitColumn < 0) {
    const firstData = rows.findIndex((row) => parseDate(String(row[0] ?? "")) !== null);
    if (firstData >= 0) {
      start = firstData;
      dateColumn = 0;
      descriptionColumn = 1;
      debitColumn = 2;
      creditColumn = 3;
    }
  }

  const result: ParsedMutation[] = [];
  for (const row of rows.slice(start)) {
    if (!row?.some((cell) => String(cell ?? "").trim())) continue;
    const date = parseDate(String(row[dateColumn] ?? ""));
    const debit = parseAmount(String(row[debitColumn] ?? ""));
    const credit = parseAmount(String(row[creditColumn] ?? ""));
    const amount = credit || debit;
    if (!date || amount <= 0) continue;
    result.push({
      transactionDate: date,
      description: String(row[descriptionColumn] ?? "").trim(),
      debit,
      credit,
      amount,
      direction: debit > 0 && credit <= 0 ? "OUT" : "IN",
      bank: bankColumn >= 0 ? String(row[bankColumn] ?? "").trim() || null : null,
    });
  }
  return result;
}

async function syncConfig(config: SheetConfig): Promise<{ imported: number; total: number; existing: number }> {
  try {
    const rows = await readSpreadsheetValues(config.sheet_id, config.tab_name);
    const parsed = parseRows(rows);
    if (parsed.length === 0) {
      await pool.query(
        `update public.bank_sheet_configs
            set last_synced_at = now(), last_sync_status = $1, last_sync_error = null, updated_at = now()
          where id = $2`,
        ["success", config.id],
      );
      return { imported: 0, total: rows.length > 0 ? rows.length - 1 : 0, existing: 0 };
    }

    const bankAccount = config.bank_account_number?.trim() || null;
    let imported = 0;
    let existing = 0;
    for (const row of parsed) {
      const key = canonicalKey(row, config.company_id, null);
      const inserted = await pool.query<{ id: number }>(
        `insert into public.bank_mutations
          (mutation_key, canonical_key, transaction_date, description, amount, direction,
           credit_amount, debit_amount, normalized_description, provider_name,
           bank_account_id, source_classification, status, source, source_account,
           company_id, sheet_config_id)
         values ($1, $1, $2, $3, $4, $5, $6, $7, $8, null,
                 (select id from public.company_bank_accounts
                   where company_id = $9
                     and coalesce(is_active, true) = true
                     and ($10::text is null or account_number = $10)
                   order by id limit 1),
                 'actual_bank_mutation', 'unmatched', 'google_sheet', $11, $9, $12)
         on conflict do nothing
         returning id`,
        [
          key,
          row.transactionDate,
          row.description,
          row.amount,
          row.direction,
          row.credit,
          row.debit,
          normalizeDescription(row.description),
          config.company_id,
          bankAccount,
          row.bank,
          config.id,
        ],
      );
      if (inserted.rowCount) imported += inserted.rowCount;
      else existing += 1;
    }

    await pool.query(
      `update public.bank_sheet_configs
          set last_synced_at = now(), last_sync_status = $1, last_sync_error = null, updated_at = now()
        where id = $2`,
      ["success", config.id],
    );
    return { imported, total: parsed.length, existing };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(
      `update public.bank_sheet_configs
          set last_synced_at = now(), last_sync_status = $1, last_sync_error = $2, updated_at = now()
        where id = $3`,
      ["error", message.slice(0, 500), config.id],
    ).catch(() => undefined);
    throw error;
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
    message: `Sync selesai: ${stats.imported} mutasi baru dari ${stats.total} baris`,
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