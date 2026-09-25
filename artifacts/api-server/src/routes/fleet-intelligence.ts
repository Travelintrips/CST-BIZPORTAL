import { Router } from "express";
import { pool } from "@workspace/db";
import { authenticateAdmin, type AdminRequest } from "./admin-auth";

const router = Router();

router.use((req, res, next) => {
  void authenticateAdmin(req as AdminRequest, res, next);
});

type SnapshotRow = {
  driver_name: string;
  phone_number: string;
  license_plate: string;
  rental_fee_daily: number;
  outstanding: number;
  status: string;
  match_status?: "found" | "unmatched";
  matched_driver_id?: number | null;
  matched_name?: string | null;
};

function companyId(req: AdminRequest): number {
  const id = Number(req.adminUser?.companyId);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error("Company ID tidak tersedia pada session BizPortal.");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return id;
}

function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function numberValue(value: unknown): number {
  const raw = String(value ?? "")
    .replace(/\t/g, "")
    .replace(/rp\.?/gi, "")
    .replace(/\s/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(/,/g, ".");
  const parsed = Number(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanPhone(value: unknown): string {
  return String(value ?? "").replace(/\t/g, "").trim();
}

function parseSnapshotCsv(content: string): Array<Omit<SnapshotRow, "match_status" | "matched_driver_id" | "matched_name">> {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = csvCells(lines[0]).map((h) => h.trim().toLowerCase());
  const find = (...names: string[]) => headers.findIndex((h) => names.includes(h));

  const nameIdx = find("driver name", "driver_name", "nama driver", "nama");
  const phoneIdx = find("phone number", "phone_number", "driver phone", "no hp", "nomor telepon");
  const plateIdx = find("license plate", "license_plate", "vehicle plate", "plat", "nomor kendaraan");
  const feeIdx = find("rental fee(daily)", "rental fee (daily)", "rental_fee_daily", "rental fee");
  const outIdx = find("outstanding", "outstanding amount", "outstanding_amount");
  const statusIdx = find("status");

  if (nameIdx < 0 || outIdx < 0) {
    throw new Error("CSV wajib memiliki kolom Driver Name dan Outstanding.");
  }

  return lines.slice(1).map((line) => {
    const cells = csvCells(line);
    return {
      driver_name: String(cells[nameIdx] ?? "").trim(),
      phone_number: phoneIdx >= 0 ? cleanPhone(cells[phoneIdx]) : "",
      license_plate: plateIdx >= 0 ? String(cells[plateIdx] ?? "").trim() : "",
      rental_fee_daily: feeIdx >= 0 ? numberValue(cells[feeIdx]) : 0,
      outstanding: numberValue(cells[outIdx]),
      status: statusIdx >= 0 ? String(cells[statusIdx] ?? "").trim() : "Active",
    };
  }).filter((row) => row.driver_name);
}

async function ensureFleetTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.fleet_outstanding (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      driver_id INTEGER,
      driver_external_id TEXT,
      driver_name TEXT NOT NULL,
      driver_phone TEXT,
      vehicle_plate TEXT,
      outstanding_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      rental_fee_daily NUMERIC(18,2) NOT NULL DEFAULT 0,
      last_updated_date DATE,
      status TEXT NOT NULL DEFAULT 'open',
      snapshot_source TEXT,
      due_days INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS fleet_outstanding_company_status_idx
      ON public.fleet_outstanding(company_id, status)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.fleet_outstanding_import_log (
      id BIGSERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      report_file_name TEXT NOT NULL,
      uploaded_by TEXT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      total_rows INTEGER NOT NULL DEFAULT 0,
      rows_imported INTEGER NOT NULL DEFAULT 0,
      rows_skipped INTEGER NOT NULL DEFAULT 0,
      unmatched_drivers INTEGER NOT NULL DEFAULT 0,
      notes TEXT
    )
  `);
}

async function tableExists(name: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [`public.${name}`],
  );
  return result.rows[0]?.exists === true;
}

router.get("/dashboard", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const month = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month)
      ? req.query.month
      : null;

    const outstanding = await pool.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(outstanding_amount),0)::numeric AS total_amount
         FROM public.fleet_outstanding
        WHERE company_id=$1 AND status='open'`,
      [cid],
    );

    const topDrivers = await pool.query(
      `SELECT driver_name AS name, vehicle_plate, 0::int AS trips, outstanding_amount AS outstanding
         FROM public.fleet_outstanding
        WHERE company_id=$1 AND status='open'
        ORDER BY outstanding_amount DESC
        LIMIT 10`,
      [cid],
    );

    let kpi: Record<string, unknown> = {
      total_drivers: 0,
      total_trips: 0,
      total_amount_raw: 0,
      total_rental_due: 0,
      total_incentive: 0,
      total_commission: 0,
      total_deduction: 0,
      total_net: 0,
      total_gross: 0,
    };
    let trend: Record<string, unknown>[] = [];
    let rawTotals: Record<string, unknown> = { raw_outstanding_total: 0, raw_row_count: 0 };
    let lastUploadDate: string | null = null;

    if (await tableExists("gojek_raw_transactions")) {
      const periodSql = month
        ? "date_iso >= ($2 || '-01')::date AND date_iso < (($2 || '-01')::date + interval '1 month')"
        : "date_iso >= CURRENT_DATE - ($2::int * interval '1 day')";
      const periodValue: string | number = month ?? days;

      const [kpiResult, trendResult, rawResult] = await Promise.all([
        pool.query(
          `SELECT COUNT(DISTINCT NULLIF(driver_external_id,''))::int AS total_drivers,
                  COUNT(*)::int AS total_trips,
                  COALESCE(SUM(amount),0)::numeric AS total_amount_raw,
                  COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0)::numeric AS total_rental_due,
                  COALESCE(SUM(amount),0)::numeric AS total_net,
                  0::numeric AS total_incentive,
                  0::numeric AS total_commission,
                  0::numeric AS total_deduction,
                  0::numeric AS total_gross
             FROM public.gojek_raw_transactions
            WHERE company_id=$1 AND ${periodSql}`,
          [cid, periodValue],
        ),
        pool.query(
          `SELECT date_iso::text AS summary_date,
                  COALESCE(SUM(amount),0)::numeric AS net_revenue,
                  COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0)::numeric AS gross_revenue,
                  COUNT(DISTINCT NULLIF(driver_external_id,''))::int AS active_drivers,
                  COUNT(*)::int AS total_trips
             FROM public.gojek_raw_transactions
            WHERE company_id=$1 AND date_iso IS NOT NULL AND ${periodSql}
            GROUP BY date_iso
            ORDER BY date_iso`,
          [cid, periodValue],
        ),
        pool.query(
          `SELECT COUNT(*)::int AS raw_row_count,
                  COALESCE(SUM(amount),0)::numeric AS raw_total_amount,
                  COALESCE((
                    SELECT SUM(x.total_outstanding_balance)
                      FROM (
                        SELECT DISTINCT ON (driver_external_id)
                               driver_external_id, total_outstanding_balance
                          FROM public.gojek_raw_transactions
                         WHERE company_id=$1
                           AND NULLIF(driver_external_id,'') IS NOT NULL
                           AND total_outstanding_balance IS NOT NULL
                         ORDER BY driver_external_id, date_iso DESC NULLS LAST, id DESC
                      ) x
                  ),0)::numeric AS raw_outstanding_total
             FROM public.gojek_raw_transactions
            WHERE company_id=$1`,
          [cid],
        ),
      ]);
      kpi = kpiResult.rows[0] ?? kpi;
      trend = trendResult.rows;
      rawTotals = rawResult.rows[0] ?? rawTotals;
    }

    const importDate = await pool.query<{ uploaded_at: Date }>(
      `SELECT uploaded_at
         FROM public.fleet_outstanding_import_log
        WHERE company_id=$1
        ORDER BY uploaded_at DESC
        LIMIT 1`,
      [cid],
    );
    lastUploadDate = importDate.rows[0]?.uploaded_at?.toISOString?.() ?? null;

    res.json({
      kpi,
      trend,
      topDrivers: topDrivers.rows,
      outstanding: outstanding.rows[0] ?? { count: 0, total_amount: 0 },
      rawTotals,
      lastUploadDate,
    });
  } catch (error) {
    req.log.error({ error }, "Fleet dashboard failed");
    const status = (error as { statusCode?: number }).statusCode ?? 503;
    res.status(status).json({ error: error instanceof Error ? error.message : "Fleet dashboard unavailable" });
  }
});

router.get("/outstanding", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const status = typeof req.query.status === "string" && req.query.status.trim()
      ? req.query.status.trim()
      : "open";
    const [rows, summary] = await Promise.all([
      pool.query(
        `SELECT *
           FROM public.fleet_outstanding
          WHERE company_id=$1 AND status=$2
          ORDER BY outstanding_amount DESC, driver_name ASC`,
        [cid, status],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(outstanding_amount),0)::numeric AS total,
                COALESCE(AVG(due_days),0)::numeric AS avg_due_days
           FROM public.fleet_outstanding
          WHERE company_id=$1 AND status=$2`,
        [cid, status],
      ),
    ]);
    res.json({ outstanding: rows.rows, summary: summary.rows[0] });
  } catch (error) {
    req.log.error({ error }, "Fleet outstanding list failed");
    res.status(503).json({ error: "Gagal mengambil data outstanding." });
  }
});

router.post("/outstanding/repair", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    if (!(await tableExists("gojek_raw_transactions"))) {
      const summary = await pool.query(
        `SELECT COUNT(*)::int AS drivers, COALESCE(SUM(outstanding_amount),0)::numeric AS total
           FROM public.fleet_outstanding WHERE company_id=$1 AND status='open'`,
        [cid],
      );
      res.json({ ok: true, message: "Tidak ada raw Gojek; snapshot existing dipertahankan.", summary: summary.rows[0] });
      return;
    }

    await pool.query("BEGIN");
    try {
      const latest = await pool.query<{
        driver_external_id: string;
        driver_name: string | null;
        phone_number: string | null;
        vehicle: string | null;
        total_outstanding_balance: string | number;
      }>(
        `SELECT DISTINCT ON (driver_external_id)
                driver_external_id, driver_name, phone_number, vehicle, total_outstanding_balance
           FROM public.gojek_raw_transactions
          WHERE company_id=$1
            AND NULLIF(driver_external_id,'') IS NOT NULL
            AND total_outstanding_balance IS NOT NULL
          ORDER BY driver_external_id, date_iso DESC NULLS LAST, id DESC`,
        [cid],
      );

      for (const row of latest.rows) {
        const amount = numberValue(row.total_outstanding_balance);
        if (amount <= 0) {
          await pool.query(
            `UPDATE public.fleet_outstanding
                SET status='resolved', resolved_at=NOW(), outstanding_amount=0, updated_at=NOW()
              WHERE company_id=$1 AND driver_external_id=$2 AND status='open'`,
            [cid, row.driver_external_id],
          );
          continue;
        }
        const updated = await pool.query(
          `UPDATE public.fleet_outstanding
              SET driver_name=COALESCE(NULLIF($3,''),driver_name),
                  driver_phone=COALESCE(NULLIF($4,''),driver_phone),
                  vehicle_plate=COALESCE(NULLIF($5,''),vehicle_plate),
                  outstanding_amount=$6,
                  last_updated_date=CURRENT_DATE,
                  updated_at=NOW()
            WHERE company_id=$1 AND driver_external_id=$2 AND status='open'
            RETURNING id`,
          [cid, row.driver_external_id, row.driver_name ?? "", row.phone_number ?? "", row.vehicle ?? "", amount],
        );
        if (updated.rowCount === 0) {
          await pool.query(
            `INSERT INTO public.fleet_outstanding
              (company_id,driver_external_id,driver_name,driver_phone,vehicle_plate,outstanding_amount,last_updated_date,status,snapshot_source)
             VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,'open','raw_repair')`,
            [cid, row.driver_external_id, row.driver_name || row.driver_external_id, row.phone_number, row.vehicle, amount],
          );
        }
      }
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }

    const summary = await pool.query(
      `SELECT COUNT(*)::int AS drivers, COALESCE(SUM(outstanding_amount),0)::numeric AS total
         FROM public.fleet_outstanding WHERE company_id=$1 AND status='open'`,
      [cid],
    );
    res.json({ ok: true, message: "Outstanding dihitung ulang dari raw transactions.", summary: summary.rows[0] });
  } catch (error) {
    req.log.error({ error }, "Fleet outstanding repair failed");
    res.status(503).json({ error: "Gagal memperbaiki outstanding." });
  }
});

router.post("/outstanding/snapshot/preview", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const content = typeof req.body?.content === "string" ? req.body.content : "";
    if (!content.trim()) {
      res.status(400).json({ error: "Isi CSV tidak tersedia." });
      return;
    }
    const rows = parseSnapshotCsv(content);
    const previews: SnapshotRow[] = [];
    let found = 0;
    let skipped = 0;

    const hasDrivers = await tableExists("fleet_drivers");
    for (const row of rows) {
      if (row.outstanding <= 0) {
        skipped += 1;
        continue;
      }

      let match: { id: number; name: string } | null = null;
      if (hasDrivers) {
        const suffix = row.phone_number.replace(/\D/g, "").replace(/^0/, "").slice(-9);
        const result = suffix
          ? await pool.query<{ id: number; name: string }>(
              `SELECT id,name FROM public.fleet_drivers
                WHERE company_id=$1
                  AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g') LIKE '%' || $2
                LIMIT 1`,
              [cid, suffix],
            )
          : await pool.query<{ id: number; name: string }>(
              `SELECT id,name FROM public.fleet_drivers
                WHERE company_id=$1 AND lower(name)=lower($2)
                LIMIT 1`,
              [cid, row.driver_name],
            );
        match = result.rows[0] ?? null;
      }

      if (match) found += 1;
      previews.push({
        ...row,
        match_status: match ? "found" : "unmatched",
        matched_driver_id: match?.id ?? null,
        matched_name: match?.name ?? null,
      });
    }

    res.json({
      ok: true,
      rows: previews,
      total: previews.length,
      found,
      unmatched: previews.length - found,
      skipped,
    });
  } catch (error) {
    req.log.error({ error }, "Fleet snapshot preview failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Gagal memproses CSV." });
  }
});

router.post("/outstanding/snapshot/confirm", async (req: AdminRequest, res) => {
  const client = await pool.connect();
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const inputRows = Array.isArray(req.body?.rows) ? req.body.rows as SnapshotRow[] : [];
    if (inputRows.length === 0) {
      res.status(400).json({ error: "Rows tidak boleh kosong." });
      return;
    }
    const fileName = typeof req.body?.fileName === "string" ? req.body.fileName.slice(0, 255) : "snapshot.csv";
    let updated = 0;
    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    await client.query("BEGIN");
    for (const row of inputRows) {
      try {
        if (!row.driver_name?.trim() || numberValue(row.outstanding) <= 0) {
          skipped += 1;
          continue;
        }
        const amount = numberValue(row.outstanding);
        const fee = numberValue(row.rental_fee_daily);
        const existing = await client.query(
          `SELECT id FROM public.fleet_outstanding
            WHERE company_id=$1 AND status='open' AND lower(driver_name)=lower($2)
            ORDER BY id DESC LIMIT 1`,
          [cid, row.driver_name.trim()],
        );
        if (existing.rows[0]?.id) {
          await client.query(
            `UPDATE public.fleet_outstanding
                SET driver_id=COALESCE($3,driver_id),
                    driver_phone=NULLIF($4,''),
                    vehicle_plate=NULLIF($5,''),
                    outstanding_amount=$6,
                    rental_fee_daily=$7,
                    last_updated_date=CURRENT_DATE,
                    snapshot_source='snapshot_csv',
                    updated_at=NOW()
              WHERE id=$1 AND company_id=$2`,
            [existing.rows[0].id, cid, row.matched_driver_id ?? null, row.phone_number ?? "", row.license_plate ?? "", amount, fee],
          );
          updated += 1;
        } else {
          await client.query(
            `INSERT INTO public.fleet_outstanding
              (company_id,driver_id,driver_name,driver_phone,vehicle_plate,outstanding_amount,rental_fee_daily,last_updated_date,status,snapshot_source)
             VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6,$7,CURRENT_DATE,'open','snapshot_csv')`,
            [cid, row.matched_driver_id ?? null, row.driver_name.trim(), row.phone_number ?? "", row.license_plate ?? "", amount, fee],
          );
          inserted += 1;
        }
      } catch {
        errors += 1;
      }
    }
    await client.query(
      `INSERT INTO public.fleet_outstanding_import_log
        (company_id,report_file_name,uploaded_by,total_rows,rows_imported,rows_skipped,unmatched_drivers)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [cid, fileName, req.adminUser?.email ?? "unknown", inputRows.length, updated + inserted, skipped, inserted],
    );
    await client.query("COMMIT");

    res.json({
      ok: true,
      updated,
      inserted,
      skipped,
      errors,
      total: inputRows.length,
      message: `${updated} driver diperbarui, ${inserted} driver baru${errors ? `, ${errors} gagal` : ""}`,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    req.log.error({ error }, "Fleet snapshot confirm failed");
    res.status(500).json({ error: "Gagal menyimpan snapshot outstanding." });
  } finally {
    client.release();
  }
});

router.get("/outstanding/import-log", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const result = await pool.query(
      `SELECT id,report_file_name,uploaded_by,uploaded_at,total_rows,rows_imported,rows_skipped,unmatched_drivers,notes
         FROM public.fleet_outstanding_import_log
        WHERE company_id=$1 AND uploaded_at >= NOW() - ($2::int * interval '1 day')
        ORDER BY uploaded_at DESC LIMIT 100`,
      [cid, days],
    );
    res.json({ ok: true, logs: result.rows });
  } catch (error) {
    req.log.error({ error }, "Fleet import log failed");
    res.status(503).json({ error: "Gagal mengambil riwayat import." });
  }
});

router.post("/outstanding/:id/followup", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const id = Number(req.params.id);
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : "";
    if (!Number.isSafeInteger(id) || id <= 0 || !notes) {
      res.status(400).json({ error: "ID dan catatan wajib valid." });
      return;
    }
    const result = await pool.query(
      `UPDATE public.fleet_outstanding
          SET notes=$3, updated_at=NOW()
        WHERE id=$1 AND company_id=$2 RETURNING id`,
      [id, cid, notes],
    );
    if (result.rowCount !== 1) {
      res.status(404).json({ error: "Outstanding tidak ditemukan." });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ error }, "Fleet outstanding followup failed");
    res.status(503).json({ error: "Gagal menyimpan catatan." });
  }
});

router.put("/outstanding/:id/resolve", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const id = Number(req.params.id);
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : "";
    const result = await pool.query(
      `UPDATE public.fleet_outstanding
          SET status='resolved', resolved_at=NOW(),
              notes=CASE WHEN $3='' THEN notes ELSE $3 END,
              updated_at=NOW()
        WHERE id=$1 AND company_id=$2 RETURNING id`,
      [id, cid, notes],
    );
    if (result.rowCount !== 1) {
      res.status(404).json({ error: "Outstanding tidak ditemukan." });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ error }, "Fleet outstanding resolve failed");
    res.status(503).json({ error: "Gagal menyelesaikan outstanding." });
  }
});

router.delete("/outstanding/:id", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const id = Number(req.params.id);
    const result = await pool.query(
      "DELETE FROM public.fleet_outstanding WHERE id=$1 AND company_id=$2 RETURNING id",
      [id, cid],
    );
    if (result.rowCount !== 1) {
      res.status(404).json({ error: "Outstanding tidak ditemukan." });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ error }, "Fleet outstanding delete failed");
    res.status(503).json({ error: "Gagal menghapus outstanding." });
  }
});

router.get("/partners", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_partners"))) {
      res.json({ partners: [] });
      return;
    }
    const result = await pool.query(
      "SELECT * FROM public.fleet_partners WHERE company_id=$1 ORDER BY name",
      [cid],
    );
    res.json({ partners: result.rows });
  } catch (error) {
    req.log.error({ error }, "Fleet partners failed");
    res.status(503).json({ error: "Gagal mengambil partner fleet." });
  }
});

router.get("/reports", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_reports"))) {
      res.json({ reports: [] });
      return;
    }
    const result = await pool.query(
      "SELECT * FROM public.fleet_reports WHERE company_id=$1 ORDER BY id DESC LIMIT 100",
      [cid],
    );
    res.json({ reports: result.rows });
  } catch (error) {
    req.log.error({ error }, "Fleet reports failed");
    res.status(503).json({ error: "Gagal mengambil report fleet." });
  }
});

export default router;
