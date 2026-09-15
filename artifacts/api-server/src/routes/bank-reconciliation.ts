import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { inspectSpreadsheet } from "../lib/google-sheets";

interface SheetConfigInput {
  company_id?: number | null;
  label?: string;
  sheet_id?: string;
  bank_account_number?: string | null;
  bank_name?: string | null;
  tab_name?: string;
  is_active?: boolean;
}

const router: IRouter = Router();

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

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
    const result = await pool.query(
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
    const result = await pool.query(
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
    const result = await pool.query(
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
    const result = await pool.query(
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

export default router;