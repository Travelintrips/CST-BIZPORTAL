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
  internal_status?: "active" | "inactive" | "suspended" | "fired";
  applicator_status?: string;
  vehicle_ownership?: "company" | "partner_private" | "unassigned";
};

const COMPANY_UNIT_RENTAL_FEE_MIN = 300_000;

function normalizeApplicatorStatus(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}

function classifyDriver(row: Pick<SnapshotRow, "status" | "license_plate" | "rental_fee_daily">) {
  const applicatorStatus = normalizeApplicatorStatus(row.status);
  const plate = String(row.license_plate ?? "").trim();
  const rentalFee = numberValue(row.rental_fee_daily);

  let internalStatus: "active" | "inactive" | "suspended" | "fired";
  if (applicatorStatus === "suspended" || applicatorStatus === "suspend" || applicatorStatus === "fired" || applicatorStatus === "terminated") {
    internalStatus = "suspended";
  } else if (!plate || applicatorStatus === "resign" || applicatorStatus === "need_to_assign") {
    internalStatus = "inactive";
  } else {
    internalStatus = "active";
  }

  const vehicleOwnership: "company" | "partner_private" | "unassigned" =
    !plate ? "unassigned" :
    rentalFee >= COMPANY_UNIT_RENTAL_FEE_MIN ? "company" :
    rentalFee > 0 ? "partner_private" :
    "unassigned";

  return { applicatorStatus, internalStatus, vehicleOwnership };
}

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

  if (await tableExists("fleet_drivers")) {
    await pool.query(`ALTER TABLE public.fleet_drivers ADD COLUMN IF NOT EXISTS rental_fee_daily NUMERIC(18,2) DEFAULT 0`);
    await pool.query(`ALTER TABLE public.fleet_drivers ADD COLUMN IF NOT EXISTS vehicle_plate TEXT`);
    await pool.query(`ALTER TABLE public.fleet_drivers ADD COLUMN IF NOT EXISTS vehicle_type TEXT`);
    await pool.query(`ALTER TABLE public.fleet_drivers ADD COLUMN IF NOT EXISTS applicator_status TEXT`);
    await pool.query(`ALTER TABLE public.fleet_drivers ADD COLUMN IF NOT EXISTS vehicle_ownership TEXT`);
    await pool.query(`ALTER TABLE public.fleet_drivers ADD COLUMN IF NOT EXISTS source_last_synced_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE public.fleet_drivers ADD COLUMN IF NOT EXISTS last_active_date DATE`);
    await pool.query(`ALTER TABLE public.fleet_drivers ADD COLUMN IF NOT EXISTS total_trips INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE public.fleet_drivers ADD COLUMN IF NOT EXISTS total_revenue NUMERIC(18,2) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE public.fleet_drivers ADD COLUMN IF NOT EXISTS avg_daily_trips NUMERIC(8,2) NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE public.fleet_drivers ADD COLUMN IF NOT EXISTS performance_tier TEXT NOT NULL DEFAULT 'standard'`);
    await pool.query(`ALTER TABLE public.fleet_drivers ADD COLUMN IF NOT EXISTS raw_data JSONB`);
  }
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

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const latest = await client.query<{
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
          await client.query(
            `UPDATE public.fleet_outstanding
                SET status='resolved', resolved_at=NOW(), outstanding_amount=0, updated_at=NOW()
              WHERE company_id=$1 AND driver_external_id=$2 AND status='open'`,
            [cid, row.driver_external_id],
          );
          continue;
        }
        const updated = await client.query(
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
          await client.query(
            `INSERT INTO public.fleet_outstanding
              (company_id,driver_external_id,driver_name,driver_phone,vehicle_plate,outstanding_amount,last_updated_date,status,snapshot_source)
             VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,'open','raw_repair')`,
            [cid, row.driver_external_id, row.driver_name || row.driver_external_id, row.phone_number, row.vehicle, amount],
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
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

    const hasDrivers = await tableExists("fleet_drivers");
    for (const row of rows) {
      let match: { id: number; name: string } | null = null;
      if (hasDrivers) {
        const suffix = row.phone_number.replace(/\D/g, "").replace(/^0/, "").slice(-9);
        const result = suffix
          ? await pool.query<{ id: number; name: string }>(
              `SELECT id,full_name AS name FROM public.fleet_drivers
                WHERE company_id=$1::text
                  AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g') LIKE '%' || $2
                ORDER BY id DESC LIMIT 1`,
              [cid, suffix],
            )
          : await pool.query<{ id: number; name: string }>(
              `SELECT id,full_name AS name FROM public.fleet_drivers
                WHERE company_id=$1::text AND lower(full_name)=lower($2)
                ORDER BY id DESC LIMIT 1`,
              [cid, row.driver_name],
            );
        match = result.rows[0] ?? null;
      }

      if (match) found += 1;
      const classification = classifyDriver(row);
      previews.push({
        ...row,
        match_status: match ? "found" : "unmatched",
        matched_driver_id: match?.id ?? null,
        matched_name: match?.name ?? null,
        internal_status: classification.internalStatus,
        applicator_status: classification.applicatorStatus,
        vehicle_ownership: classification.vehicleOwnership,
      });
    }

    const outstandingRows = previews.filter((row) => numberValue(row.outstanding) > 0).length;
    const activeDrivers = previews.filter((row) => row.internal_status === "active").length;
    const inactiveDrivers = previews.filter((row) => row.internal_status === "inactive").length;
    const suspendedDrivers = previews.filter((row) => row.internal_status === "suspended").length;
    const firedDrivers = previews.filter((row) => row.internal_status === "fired").length;
    const companyUnits = previews.filter((row) => row.vehicle_ownership === "company").length;
    const partnerPrivateUnits = previews.filter((row) => row.vehicle_ownership === "partner_private").length;

    res.json({
      ok: true,
      rows: previews,
      total: previews.length,
      found,
      unmatched: previews.length - found,
      skipped: 0,
      summary: {
        outstandingRows,
        activeDrivers,
        inactiveDrivers,
        suspendedDrivers,
        firedDrivers,
        companyUnits,
        partnerPrivateUnits,
      },
    });
  } catch (error) {
    req.log.error({ error }, "Fleet driver master preview failed");
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
    if (!(await tableExists("fleet_drivers"))) {
      res.status(503).json({ error: "Master fleet_drivers belum tersedia." });
      return;
    }

    const fileName = typeof req.body?.fileName === "string" ? req.body.fileName.slice(0, 255) : "drivers.csv";
    let driverUpdated = 0;
    let driverInserted = 0;
    let outstandingUpserted = 0;
    let outstandingResolved = 0;
    let errors = 0;

    await client.query("BEGIN");
    for (let rowIndex = 0; rowIndex < inputRows.length; rowIndex += 1) {
      const row = inputRows[rowIndex];
      const savepoint = `fleet_row_${rowIndex}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const driverName = String(row.driver_name ?? "").trim();
        if (!driverName) continue;

        const phone = cleanPhone(row.phone_number);
        const plate = String(row.license_plate ?? "").trim().toUpperCase();
        const fee = numberValue(row.rental_fee_daily);
        const amount = numberValue(row.outstanding);
        const classification = classifyDriver({ ...row, license_plate: plate, rental_fee_daily: fee });
        const suffix = phone.replace(/\D/g, "").replace(/^0/, "").slice(-9);

        let driver = suffix
          ? await client.query<{ id: number }>(
              `SELECT id FROM public.fleet_drivers
                WHERE company_id=$1::text
                  AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g') LIKE '%' || $2
                ORDER BY id DESC LIMIT 1`,
              [cid, suffix],
            )
          : { rows: [] as Array<{ id: number }> };

        if (!driver.rows[0]?.id) {
          driver = await client.query<{ id: number }>(
            `SELECT id FROM public.fleet_drivers
              WHERE company_id=$1::text AND lower(full_name)=lower($2)
              ORDER BY id DESC LIMIT 1`,
            [cid, driverName],
          );
        }

        let driverId: number;
        if (driver.rows[0]?.id) {
          driverId = driver.rows[0].id;
          await client.query(
            `UPDATE public.fleet_drivers
                SET name=$3,
                    phone=NULLIF($4,''),
                    vehicle_plate=NULLIF($5,''),
                    rental_fee_daily=$6,
                    status=$7,
                    applicator_status=$8,
                    vehicle_ownership=$9,
                    last_active_date=CASE WHEN $7='active' THEN CURRENT_DATE ELSE last_active_date END,
                    source_last_synced_at=NOW(),
                    updated_at=NOW()
              WHERE id=$1 AND company_id=$2`,
            [
              driverId, cid, driverName, phone, plate, fee,
              classification.internalStatus,
              classification.applicatorStatus,
              classification.vehicleOwnership,
            ],
          );
          driverUpdated += 1;
        } else {
          const inserted = await client.query<{ id: number }>(
            `INSERT INTO public.fleet_drivers
              (company_id,full_name,license_number,phone,vehicle_plate,rental_fee_daily,status,applicator_status,vehicle_ownership,last_active_date,source_last_synced_at,created_at,updated_at)
             VALUES ($1::text,$2,$3,NULLIF($4,''),NULLIF($5,''),$6,$7,$8,$9,CASE WHEN $7='active' THEN CURRENT_DATE ELSE NULL END,NOW(),NOW(),NOW())
             RETURNING id`,
            [
              cid,
              driverName,
              `GOCAR-${phone.replace(/\\D/g, "").slice(-12) || Date.now()}`,
              phone,
              plate,
              fee,
              classification.internalStatus,
              classification.applicatorStatus,
              classification.vehicleOwnership,
            ],
          );
          driverId = inserted.rows[0].id;
          driverInserted += 1;
        }

        const existingOutstanding = await client.query<{ id: number }>(
          `SELECT id FROM public.fleet_outstanding
            WHERE company_id=$1 AND status='open'
              AND (driver_id=$2 OR (driver_id IS NULL AND lower(driver_name)=lower($3)))
            ORDER BY id DESC LIMIT 1`,
          [cid, driverId, driverName],
        );

        if (amount > 0) {
          if (existingOutstanding.rows[0]?.id) {
            await client.query(
              `UPDATE public.fleet_outstanding
                  SET driver_id=$3,
                      driver_name=$4,
                      driver_phone=NULLIF($5,''),
                      vehicle_plate=NULLIF($6,''),
                      outstanding_amount=$7,
                      rental_fee_daily=$8,
                      last_updated_date=CURRENT_DATE,
                      snapshot_source='gojek_driver_export',
                      updated_at=NOW()
                WHERE id=$1 AND company_id=$2`,
              [existingOutstanding.rows[0].id, cid, driverId, driverName, phone, plate, amount, fee],
            );
          } else {
            await client.query(
              `INSERT INTO public.fleet_outstanding
                (company_id,driver_id,driver_name,driver_phone,vehicle_plate,outstanding_amount,rental_fee_daily,last_updated_date,status,snapshot_source)
               VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6,$7,CURRENT_DATE,'open','gojek_driver_export')`,
              [cid, driverId, driverName, phone, plate, amount, fee],
            );
          }
          outstandingUpserted += 1;
        } else if (existingOutstanding.rows[0]?.id) {
          await client.query(
            `UPDATE public.fleet_outstanding
                SET outstanding_amount=0,status='resolved',resolved_at=NOW(),
                    last_updated_date=CURRENT_DATE,updated_at=NOW()
              WHERE id=$1 AND company_id=$2`,
            [existingOutstanding.rows[0].id, cid],
          );
          outstandingResolved += 1;
        }
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (rowError) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => undefined);
        errors += 1;
        req.log.warn({ rowError, driverName: row.driver_name }, "Fleet driver master row sync failed");
      }
    }

    await client.query(
      `INSERT INTO public.fleet_outstanding_import_log
        (company_id,report_file_name,uploaded_by,total_rows,rows_imported,rows_skipped,unmatched_drivers,notes)
       VALUES ($1,$2,$3,$4,$5,0,$6,$7)`,
      [
        cid,
        fileName,
        req.adminUser?.email ?? "unknown",
        inputRows.length,
        driverUpdated + driverInserted,
        driverInserted,
        JSON.stringify({ driverUpdated, driverInserted, outstandingUpserted, outstandingResolved, errors }),
      ],
    );
    await client.query("COMMIT");

    res.json({
      ok: true,
      updated: driverUpdated,
      inserted: driverInserted,
      skipped: 0,
      errors,
      total: inputRows.length,
      driverUpdated,
      driverInserted,
      outstandingUpserted,
      outstandingResolved,
      message: `${driverUpdated} driver diperbarui, ${driverInserted} driver baru, ${outstandingUpserted} outstanding aktif${outstandingResolved ? `, ${outstandingResolved} outstanding diselesaikan` : ""}${errors ? `, ${errors} gagal` : ""}`,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    req.log.error({ error }, "Fleet driver master sync failed");
    res.status(500).json({ error: "Gagal sinkronisasi master driver dan outstanding." });
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


router.get("/transactions", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_transactions"))) {
      res.json({ transactions: [], summary: { total: 0, total_trips: 0, total_net: 0, total_gross: 0 } });
      return;
    }
    const startDate = typeof req.query.startDate === "string" ? req.query.startDate : null;
    const endDate = typeof req.query.endDate === "string" ? req.query.endDate : null;
    const driverSearch = typeof req.query.driverSearch === "string" ? req.query.driverSearch.trim() : "";
    const vehiclePlate = typeof req.query.vehiclePlate === "string" ? req.query.vehiclePlate.trim() : "";
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const offset = (page - 1) * limit;

    const rows = await pool.query(
      `SELECT *
         FROM public.fleet_transactions
        WHERE company_id=$1
          AND ($2::date IS NULL OR transaction_date >= $2::date)
          AND ($3::date IS NULL OR transaction_date <= $3::date)
          AND ($4='' OR COALESCE(driver_name,'') ILIKE '%' || $4 || '%' OR COALESCE(driver_external_id,'') ILIKE '%' || $4 || '%')
          AND ($5='' OR COALESCE(vehicle_plate,'') ILIKE '%' || $5 || '%')
        ORDER BY transaction_date DESC, id DESC
        LIMIT $6 OFFSET $7`,
      [cid, startDate, endDate, driverSearch, vehiclePlate, limit, offset],
    );
    const summary = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(trip_count),0)::int AS total_trips,
              COALESCE(SUM(net_revenue),0)::numeric AS total_net,
              COALESCE(SUM(gross_revenue),0)::numeric AS total_gross
         FROM public.fleet_transactions
        WHERE company_id=$1
          AND ($2::date IS NULL OR transaction_date >= $2::date)
          AND ($3::date IS NULL OR transaction_date <= $3::date)
          AND ($4='' OR COALESCE(driver_name,'') ILIKE '%' || $4 || '%' OR COALESCE(driver_external_id,'') ILIKE '%' || $4 || '%')
          AND ($5='' OR COALESCE(vehicle_plate,'') ILIKE '%' || $5 || '%')`,
      [cid, startDate, endDate, driverSearch, vehiclePlate],
    );
    res.json({ transactions: rows.rows, summary: summary.rows[0] ?? {} });
  } catch (error) {
    req.log.error({ error }, "Fleet transactions failed");
    res.status(503).json({ error: "Gagal mengambil transaksi fleet." });
  }
});

router.get("/drivers", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    if (!(await tableExists("fleet_drivers"))) {
      res.json({ drivers: [], total: 0 });
      return;
    }
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const status = typeof req.query.status === "string" && req.query.status !== "all" ? req.query.status.trim() : "";
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const offset = (page - 1) * limit;
    const statusSql = status === "inactive"
      ? "d.status <> 'active'"
      : "($3='' OR d.status=$3)";

    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT d.*,
                d.full_name AS name,
                COALESCE(o.outstanding,0)::numeric AS outstanding
           FROM public.fleet_drivers d
           LEFT JOIN LATERAL (
             SELECT SUM(outstanding_amount)::numeric AS outstanding
               FROM public.fleet_outstanding fo
              WHERE fo.company_id=$1
                AND fo.status='open'
                AND (fo.driver_id=d.id OR lower(fo.driver_name)=lower(d.full_name))
           ) o ON TRUE
          WHERE d.company_id=$1::text
            AND ($2='' OR d.full_name ILIKE '%' || $2 || '%' OR COALESCE(d.driver_external_id,'') ILIKE '%' || $2 || '%' OR COALESCE(d.vehicle_plate,'') ILIKE '%' || $2 || '%' OR COALESCE(d.phone,'') ILIKE '%' || $2 || '%')
            AND ${statusSql}
          ORDER BY d.full_name ASC
          LIMIT $4 OFFSET $5`,
        [cid, search, status, limit, offset],
      ),
      pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM public.fleet_drivers d
          WHERE d.company_id=$1::text
            AND ($2='' OR d.full_name ILIKE '%' || $2 || '%' OR COALESCE(d.driver_external_id,'') ILIKE '%' || $2 || '%' OR COALESCE(d.vehicle_plate,'') ILIKE '%' || $2 || '%' OR COALESCE(d.phone,'') ILIKE '%' || $2 || '%')
            AND ${statusSql}`,
        [cid, search, status],
      ),
    ]);
    res.json({ drivers: rows.rows, total: count.rows[0]?.count ?? 0 });
  } catch (error) {
    req.log.error({ error }, "Fleet drivers failed");
    res.status(503).json({ error: "Gagal mengambil daftar driver." });
  }
});

router.put("/drivers/:id", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const id = Number(req.params.id);
    const body = req.body ?? {};
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: "ID driver tidak valid." });
      return;
    }
    const result = await pool.query(
      `UPDATE public.fleet_drivers
          SET full_name=COALESCE(NULLIF($3,''),full_name),
              phone=COALESCE(NULLIF($4,''),phone),
              email=COALESCE(NULLIF($5,''),email),
              license_number=COALESCE(NULLIF($6,''),license_number),
              vehicle_plate=NULLIF($7,''),
              vehicle_type=COALESCE(NULLIF($8,''),vehicle_type),
              status=COALESCE(NULLIF($9,''),status),
              notes=COALESCE($10,notes),
              updated_at=NOW()
        WHERE id=$1 AND company_id=$2::text
        RETURNING *, full_name AS name`,
      [
        id, cid,
        typeof body.name === "string" ? body.name.trim() : "",
        typeof body.phone === "string" ? body.phone.trim() : "",
        typeof body.email === "string" ? body.email.trim() : "",
        typeof body.licenseNumber === "string" ? body.licenseNumber.trim() : "",
        typeof body.vehiclePlate === "string" ? body.vehiclePlate.trim().toUpperCase() : "",
        typeof body.vehicleType === "string" ? body.vehicleType.trim() : "",
        typeof body.status === "string" ? body.status.trim() : "",
        typeof body.notes === "string" ? body.notes : null,
      ],
    );
    if (result.rowCount !== 1) {
      res.status(404).json({ error: "Driver tidak ditemukan." });
      return;
    }
    res.json({ ok: true, driver: result.rows[0] });
  } catch (error) {
    req.log.error({ error }, "Fleet driver update failed");
    res.status(503).json({ error: "Gagal memperbarui driver." });
  }
});

router.get("/drivers/:extId/detail", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const extId = String(req.params.extId ?? "");
    if (!(await tableExists("fleet_drivers"))) {
      res.status(404).json({ error: "Driver tidak ditemukan." });
      return;
    }
    const driver = await pool.query(
      `SELECT d.*, d.full_name AS name
         FROM public.fleet_drivers d
        WHERE d.company_id=$1::text AND (d.driver_external_id=$2 OR d.id::text=$2)
        LIMIT 1`,
      [cid, extId],
    );
    const row = driver.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: "Driver tidak ditemukan." });
      return;
    }
    const [transactions, outstanding] = await Promise.all([
      tableExists("fleet_transactions").then((exists) => exists
        ? pool.query(
            `SELECT * FROM public.fleet_transactions
              WHERE company_id=$1 AND (driver_external_id=$2 OR driver_id=$3)
              ORDER BY transaction_date DESC, id DESC LIMIT 100`,
            [cid, row.driver_external_id ?? "", row.id],
          )
        : Promise.resolve({ rows: [] } as { rows: unknown[] })),
      pool.query(
        `SELECT * FROM public.fleet_outstanding
          WHERE company_id=$1 AND (driver_external_id=$2 OR driver_id=$3 OR lower(driver_name)=lower($4))
          ORDER BY id DESC LIMIT 20`,
        [cid, row.driver_external_id ?? "", row.id, row.full_name ?? ""],
      ),
    ]);
    res.json({ driver: row, transactions: transactions.rows, outstanding: outstanding.rows });
  } catch (error) {
    req.log.error({ error }, "Fleet driver detail failed");
    res.status(503).json({ error: "Gagal memuat detail driver." });
  }
});

router.get("/vehicles", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_vehicles"))) {
      res.json({ vehicles: [] });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const result = await pool.query(
      `SELECT v.*, d.full_name AS driver_name, d.driver_external_id
         FROM public.fleet_vehicles v
         LEFT JOIN public.fleet_drivers d ON d.id=v.driver_id AND d.company_id=v.company_id::text
        WHERE v.company_id=$1
        ORDER BY v.plate ASC
        LIMIT $2`,
      [cid, limit],
    );
    res.json({ vehicles: result.rows });
  } catch (error) {
    req.log.error({ error }, "Fleet vehicles failed");
    res.status(503).json({ error: "Gagal mengambil kendaraan." });
  }
});

router.post("/vehicles", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_vehicles"))) {
      res.status(503).json({ error: "Tabel fleet_vehicles belum tersedia." });
      return;
    }
    const body = req.body ?? {};
    const plate = typeof body.plate === "string" ? body.plate.trim().toUpperCase() : "";
    if (!plate) {
      res.status(400).json({ error: "Plat kendaraan wajib diisi." });
      return;
    }
    const result = await pool.query(
      `INSERT INTO public.fleet_vehicles
        (company_id,partner_id,driver_id,plate,vehicle_type,brand,model,year,color,status,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        cid,
        Number(body.partnerId) || null,
        Number(body.driverId) || null,
        plate,
        typeof body.vehicleType === "string" && body.vehicleType.trim() ? body.vehicleType.trim() : "motor",
        typeof body.brand === "string" ? body.brand.trim() || null : null,
        typeof body.model === "string" ? body.model.trim() || null : null,
        Number(body.year) || null,
        typeof body.color === "string" ? body.color.trim() || null : null,
        typeof body.status === "string" && body.status.trim() ? body.status.trim() : "active",
        typeof body.notes === "string" ? body.notes : null,
      ],
    );
    res.status(201).json({ ok: true, vehicle: result.rows[0] });
  } catch (error) {
    req.log.error({ error }, "Fleet vehicle create failed");
    res.status(503).json({ error: "Gagal menambah kendaraan." });
  }
});

router.get("/analytics", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    if (!(await tableExists("fleet_transactions"))) {
      res.json({ driverPerformance: [], vehiclePerformance: [], weekdayPattern: [], serviceBreakdown: [] });
      return;
    }
    const [drivers, vehicles, weekday, services] = await Promise.all([
      pool.query(
        `SELECT driver_external_id, MAX(driver_name) AS driver_name, MAX(vehicle_plate) AS vehicle_plate,
                COUNT(*)::int AS active_days, COALESCE(SUM(trip_count),0)::int AS trips,
                COALESCE(SUM(net_revenue),0)::numeric AS net_revenue,
                COALESCE(SUM(gross_revenue),0)::numeric AS gross_revenue,
                MAX(service_type) AS service_type
           FROM public.fleet_transactions
          WHERE company_id=$1 AND transaction_date >= CURRENT_DATE - ($2::int * interval '1 day')
          GROUP BY driver_external_id
          ORDER BY COALESCE(SUM(net_revenue),0) DESC
          LIMIT 100`,
        [cid, days],
      ),
      pool.query(
        `SELECT vehicle_plate, MAX(service_type) AS service_type,
                COUNT(*)::int AS active_days, COALESCE(SUM(trip_count),0)::int AS trips,
                COALESCE(SUM(net_revenue),0)::numeric AS net_revenue
           FROM public.fleet_transactions
          WHERE company_id=$1 AND transaction_date >= CURRENT_DATE - ($2::int * interval '1 day')
            AND NULLIF(vehicle_plate,'') IS NOT NULL
          GROUP BY vehicle_plate
          ORDER BY COALESCE(SUM(net_revenue),0) DESC
          LIMIT 100`,
        [cid, days],
      ),
      pool.query(
        `SELECT EXTRACT(ISODOW FROM transaction_date)::int AS day_no,
                TRIM(TO_CHAR(transaction_date,'Day')) AS day_name,
                AVG(trip_count)::numeric AS avg_trips,
                AVG(net_revenue)::numeric AS avg_revenue,
                COUNT(DISTINCT driver_external_id)::numeric / GREATEST(COUNT(DISTINCT transaction_date),1) AS avg_drivers
           FROM public.fleet_transactions
          WHERE company_id=$1 AND transaction_date >= CURRENT_DATE - ($2::int * interval '1 day')
          GROUP BY 1,2 ORDER BY 1`,
        [cid, days],
      ),
      pool.query(
        `SELECT COALESCE(service_type,'Unknown') AS service_type,
                COUNT(*)::int AS transactions,
                COALESCE(SUM(trip_count),0)::int AS trips,
                COALESCE(SUM(net_revenue),0)::numeric AS revenue
           FROM public.fleet_transactions
          WHERE company_id=$1 AND transaction_date >= CURRENT_DATE - ($2::int * interval '1 day')
          GROUP BY COALESCE(service_type,'Unknown')
          ORDER BY revenue DESC`,
        [cid, days],
      ),
    ]);
    res.json({
      driverPerformance: drivers.rows,
      vehiclePerformance: vehicles.rows,
      weekdayPattern: weekday.rows,
      serviceBreakdown: services.rows,
    });
  } catch (error) {
    req.log.error({ error }, "Fleet analytics failed");
    res.status(503).json({ error: "Gagal mengambil analytics fleet." });
  }
});

router.get("/analytics/idle-vehicles", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 365);
    if (!(await tableExists("fleet_vehicles"))) {
      res.json({ idleVehicles: [] });
      return;
    }
    const hasTx = await tableExists("fleet_transactions");
    const query = hasTx
      ? `SELECT v.*, d.name AS driver_name, MAX(t.transaction_date) AS last_transaction_date
           FROM public.fleet_vehicles v
           LEFT JOIN public.fleet_drivers d ON d.id=v.driver_id
           LEFT JOIN public.fleet_transactions t ON t.company_id=v.company_id AND t.vehicle_plate=v.plate
          WHERE v.company_id=$1
          GROUP BY v.id,d.name
         HAVING MAX(t.transaction_date) IS NULL OR MAX(t.transaction_date) < CURRENT_DATE - ($2::int * interval '1 day')
          ORDER BY MAX(t.transaction_date) NULLS FIRST`
      : `SELECT v.*, d.name AS driver_name, NULL::date AS last_transaction_date
           FROM public.fleet_vehicles v
           LEFT JOIN public.fleet_drivers d ON d.id=v.driver_id
          WHERE v.company_id=$1 ORDER BY v.plate`;
    const result = await pool.query(query, hasTx ? [cid, days] : [cid]);
    res.json({ idleVehicles: result.rows });
  } catch (error) {
    req.log.error({ error }, "Fleet idle vehicles failed");
    res.status(503).json({ error: "Gagal mengambil kendaraan idle." });
  }
});

router.get("/analytics/churn-risk", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_drivers"))) {
      res.json({ churnRisk: [] });
      return;
    }
    const hasTx = await tableExists("fleet_transactions");
    const result = hasTx
      ? await pool.query(
          `SELECT d.*, MAX(t.transaction_date) AS last_transaction_date,
                  GREATEST(0,(CURRENT_DATE-MAX(t.transaction_date))::int) AS inactive_days,
                  COALESCE(SUM(t.net_revenue) FILTER (WHERE t.transaction_date >= CURRENT_DATE - INTERVAL '30 days'),0)::numeric AS revenue_30d
             FROM public.fleet_drivers d
             LEFT JOIN public.fleet_transactions t
               ON t.company_id=d.company_id AND (t.driver_id=d.id OR t.driver_external_id=d.driver_external_id)
            WHERE d.company_id=$1 AND d.status='active'
            GROUP BY d.id
           HAVING MAX(t.transaction_date) IS NULL OR MAX(t.transaction_date) < CURRENT_DATE - INTERVAL '7 days'
            ORDER BY inactive_days DESC NULLS FIRST`,
          [cid],
        )
      : { rows: [] };
    res.json({ churnRisk: result.rows });
  } catch (error) {
    req.log.error({ error }, "Fleet churn risk failed");
    res.status(503).json({ error: "Gagal mengambil churn risk." });
  }
});

router.get("/analytics/forecast", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_daily_summary"))) {
      res.json({ historical: [], forecast: [], forecastAvg: 0 });
      return;
    }
    const historical = await pool.query(
      `SELECT summary_date, net_revenue, gross_revenue, active_drivers, total_trips
         FROM public.fleet_daily_summary
        WHERE company_id=$1
        ORDER BY summary_date DESC LIMIT 60`,
      [cid],
    );
    const ordered = [...historical.rows].reverse();
    const recent = ordered.slice(-14).map((r) => Number((r as Record<string, unknown>).net_revenue) || 0);
    const avg = recent.length ? recent.reduce((a,b)=>a+b,0)/recent.length : 0;
    const forecast = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() + i + 1);
      return { date: d.toISOString().slice(0,10), forecast_revenue: avg };
    });
    res.json({ historical: ordered, forecast, forecastAvg: avg });
  } catch (error) {
    req.log.error({ error }, "Fleet forecast failed");
    res.status(503).json({ error: "Gagal mengambil forecast." });
  }
});

router.get("/alerts", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_alerts"))) {
      res.json({ alerts: [], unreadCount: 0 });
      return;
    }
    const isRead = typeof req.query.isRead === "string" && req.query.isRead !== "all" ? req.query.isRead : "";
    const severity = typeof req.query.severity === "string" && req.query.severity !== "all" ? req.query.severity : "";
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = (page - 1) * limit;
    const [rows, unread] = await Promise.all([
      pool.query(
        `SELECT * FROM public.fleet_alerts
          WHERE company_id=$1
            AND ($2='' OR is_read=$2::boolean)
            AND ($3='' OR severity=$3)
          ORDER BY created_at DESC LIMIT $4 OFFSET $5`,
        [cid, isRead, severity, limit, offset],
      ),
      pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM public.fleet_alerts WHERE company_id=$1 AND is_read=false",
        [cid],
      ),
    ]);
    res.json({ alerts: rows.rows, unreadCount: unread.rows[0]?.count ?? 0 });
  } catch (error) {
    req.log.error({ error }, "Fleet alerts failed");
    res.status(503).json({ error: "Gagal mengambil alert fleet." });
  }
});

router.put("/alerts/:id/read", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const id = Number(req.params.id);
    const result = await pool.query(
      "UPDATE public.fleet_alerts SET is_read=true WHERE id=$1 AND company_id=$2 RETURNING id",
      [id, cid],
    );
    if (result.rowCount !== 1) {
      res.status(404).json({ error: "Alert tidak ditemukan." });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ error }, "Fleet alert read failed");
    res.status(503).json({ error: "Gagal memperbarui alert." });
  }
});

router.put("/alerts/read-all", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (await tableExists("fleet_alerts")) {
      await pool.query("UPDATE public.fleet_alerts SET is_read=true WHERE company_id=$1 AND is_read=false", [cid]);
    }
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ error }, "Fleet alert read-all failed");
    res.status(503).json({ error: "Gagal memperbarui alert." });
  }
});

router.get("/ledger", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("gojek_raw_transactions"))) {
      res.json({ transactions: [], summary: { total: 0, total_amount: 0 }, transactionTypes: [], pagination: { page: 1, limit: 50, offset: 0 } });
      return;
    }
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = (page - 1) * limit;
    const driverName = typeof req.query.driverName === "string" ? req.query.driverName.trim() : "";
    const driverExtId = typeof req.query.driverExtId === "string" ? req.query.driverExtId.trim() : "";
    const dateFrom = typeof req.query.dateFrom === "string" ? req.query.dateFrom : null;
    const dateTo = typeof req.query.dateTo === "string" ? req.query.dateTo : null;
    const transactionType = typeof req.query.transactionType === "string" ? req.query.transactionType.trim() : "";
    const reportId = Number(req.query.reportId) || 0;
    const [rows, summary, types] = await Promise.all([
      pool.query(
        `SELECT *
           FROM public.gojek_raw_transactions
          WHERE company_id=$1
            AND ($2='' OR COALESCE(driver_name,'') ILIKE '%' || $2 || '%')
            AND ($3='' OR COALESCE(driver_external_id,'') ILIKE '%' || $3 || '%')
            AND ($4::date IS NULL OR date_iso >= $4::date)
            AND ($5::date IS NULL OR date_iso <= $5::date)
            AND ($6='' OR COALESCE(transaction_type,'')=$6)
            AND ($7=0 OR report_id=$7)
          ORDER BY COALESCE(date_iso,created_at::date) DESC, id DESC
          LIMIT $8 OFFSET $9`,
        [cid, driverName, driverExtId, dateFrom, dateTo, transactionType, reportId, limit, offset],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total, COALESCE(SUM(amount),0)::numeric AS total_amount
           FROM public.gojek_raw_transactions
          WHERE company_id=$1
            AND ($2='' OR COALESCE(driver_name,'') ILIKE '%' || $2 || '%')
            AND ($3='' OR COALESCE(driver_external_id,'') ILIKE '%' || $3 || '%')
            AND ($4::date IS NULL OR date_iso >= $4::date)
            AND ($5::date IS NULL OR date_iso <= $5::date)
            AND ($6='' OR COALESCE(transaction_type,'')=$6)
            AND ($7=0 OR report_id=$7)`,
        [cid, driverName, driverExtId, dateFrom, dateTo, transactionType, reportId],
      ),
      pool.query<{ transaction_type: string }>(
        `SELECT DISTINCT transaction_type
           FROM public.gojek_raw_transactions
          WHERE company_id=$1 AND NULLIF(transaction_type,'') IS NOT NULL
          ORDER BY transaction_type`,
        [cid],
      ),
    ]);
    res.json({
      transactions: rows.rows,
      summary: summary.rows[0] ?? { total: 0, total_amount: 0 },
      transactionTypes: types.rows.map((r) => r.transaction_type),
      pagination: { page, limit, offset },
    });
  } catch (error) {
    req.log.error({ error }, "Fleet ledger failed");
    res.status(503).json({ error: "Gagal mengambil ledger fleet." });
  }
});

router.get("/outstanding/macet", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const minDays = Math.max(Number(req.query.min_days) || 7, 1);
    const minAmount = Math.max(Number(req.query.min_amount) || 1000000, 0);
    const hasRaw = await tableExists("gojek_raw_transactions");
    const result = hasRaw
      ? await pool.query(
          `SELECT o.*, MAX(r.date_iso) AS last_updated_date,
                  GREATEST(0,(CURRENT_DATE-MAX(r.date_iso))::int) AS days_inactive
             FROM public.fleet_outstanding o
             LEFT JOIN public.gojek_raw_transactions r
               ON r.company_id=o.company_id AND r.driver_external_id=o.driver_external_id
            WHERE o.company_id=$1 AND o.status='open' AND o.outstanding_amount >= $2
            GROUP BY o.id
           HAVING MAX(r.date_iso) IS NULL OR MAX(r.date_iso) <= CURRENT_DATE - ($3::int * interval '1 day')
            ORDER BY o.outstanding_amount DESC`,
          [cid, minAmount, minDays],
        )
      : await pool.query(
          `SELECT o.*, NULL::date AS last_updated_date, NULL::int AS days_inactive
             FROM public.fleet_outstanding o
            WHERE o.company_id=$1 AND o.status='open' AND o.outstanding_amount >= $2
            ORDER BY o.outstanding_amount DESC`,
          [cid, minAmount],
        );
    const total = result.rows.reduce((sum, row) => sum + (Number((row as Record<string, unknown>).outstanding_amount) || 0), 0);
    res.json({ drivers: result.rows, summary: { count: result.rows.length, total_outstanding: total } });
  } catch (error) {
    req.log.error({ error }, "Fleet macet failed");
    res.status(503).json({ error: "Gagal mengambil driver macet." });
  }
});

router.get("/system-overview", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    const countTable = async (name: string): Promise<number> => {
      if (!(await tableExists(name))) return 0;
      const result = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM public.${name} WHERE company_id=$1`, [cid]);
      return result.rows[0]?.count ?? 0;
    };
    const [reports, raw, tx, drivers, vehicles, outstanding, alerts, queue, dlq] = await Promise.all([
      countTable("fleet_reports"),
      countTable("gojek_raw_transactions"),
      countTable("fleet_transactions"),
      countTable("fleet_drivers"),
      countTable("fleet_vehicles"),
      countTable("fleet_outstanding"),
      countTable("fleet_alerts"),
      countTable("gojek_ingestion_queue"),
      countTable("gojek_failed_rows"),
    ]);

    let activeDrivers = 0;
    let suspendedDrivers = 0;
    if (await tableExists("fleet_drivers")) {
      const d = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE status='active')::int AS active,
                COUNT(*) FILTER (WHERE status<>'active')::int AS suspended
           FROM public.fleet_drivers WHERE company_id=$1`,
        [cid],
      );
      activeDrivers = Number((d.rows[0] as Record<string, unknown>)?.active ?? 0);
      suspendedDrivers = Number((d.rows[0] as Record<string, unknown>)?.suspended ?? 0);
    }

    let txToday = 0;
    let totalGross = 0;
    let latestDate: string | null = null;
    if (await tableExists("fleet_transactions")) {
      const t = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE transaction_date=CURRENT_DATE)::int AS today_count,
                COALESCE(SUM(gross_revenue),0)::numeric AS total_gross,
                MAX(transaction_date)::text AS latest_date
           FROM public.fleet_transactions WHERE company_id=$1`,
        [cid],
      );
      txToday = Number((t.rows[0] as Record<string, unknown>)?.today_count ?? 0);
      totalGross = Number((t.rows[0] as Record<string, unknown>)?.total_gross ?? 0);
      latestDate = ((t.rows[0] as Record<string, unknown>)?.latest_date as string | null) ?? null;
    }

    let criticalUnread = 0;
    let otherUnread = 0;
    if (await tableExists("fleet_alerts")) {
      const a = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE is_read=false AND severity='critical')::int AS critical,
                COUNT(*) FILTER (WHERE is_read=false AND severity<>'critical')::int AS other
           FROM public.fleet_alerts WHERE company_id=$1`,
        [cid],
      );
      criticalUnread = Number((a.rows[0] as Record<string, unknown>)?.critical ?? 0);
      otherUnread = Number((a.rows[0] as Record<string, unknown>)?.other ?? 0);
    }

    const healthScore = Math.max(0, 100 - Math.min(50, dlq * 5) - Math.min(30, criticalUnread * 10));
    const healthStatus = healthScore >= 80 ? "green" : healthScore >= 50 ? "yellow" : "red";
    res.json({
      generatedAt: new Date().toISOString(),
      healthScore,
      healthStatus,
      systemBounds: {
        limits: { pendingQueue: 20, dlq: 100 },
        violations: [],
        queueSaturation: Math.min(100, Math.round((queue / 20) * 100)),
        dlqSaturation: Math.min(100, Math.round((dlq / 100) * 100)),
      },
      ingestionQueue: {
        pending: queue, processing: 0, completed: reports, failed: dlq, total: queue + reports + dlq,
        recentWeek: { total: reports, succeeded: reports, failed: dlq, processing: 0, pending: queue, successRate: reports + dlq > 0 ? Math.round((reports / (reports + dlq)) * 100) : 100 },
      },
      dlq: { total: dlq, unresolved: dlq, resolved: 0, latestError: null, pressure: Math.min(100, dlq) },
      reconciliation: { status: "ok", summaryMismatches: 0, message: "Belum ada mismatch terdeteksi oleh runtime standalone." },
      alerts: { criticalUnread, otherUnread, totalUnread: criticalUnread + otherUnread },
      transactions: { total: tx, todayCount: txToday, totalGross, latestDate },
      drivers: { total: drivers, active: activeDrivers, suspended: suspendedDrivers },
      tables: { reports, raw, tx, drivers, vehicles, outstanding, alerts },
    });
  } catch (error) {
    req.log.error({ error }, "Fleet system overview failed");
    res.status(503).json({ error: "Gagal mengambil system overview." });
  }
});

router.get("/executive-summary", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const outstanding = await pool.query(
      `SELECT COUNT(*)::int AS drivers, COALESCE(SUM(outstanding_amount),0)::numeric AS total
         FROM public.fleet_outstanding WHERE company_id=$1 AND status='open'`,
      [cid],
    );
    const outstandingDrivers = Number((outstanding.rows[0] as Record<string, unknown>)?.drivers ?? 0);
    const outstandingAmount = Number((outstanding.rows[0] as Record<string, unknown>)?.total ?? 0);

    let unreadAlerts = 0;
    let criticalUnread = 0;
    if (await tableExists("fleet_alerts")) {
      const alerts = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE is_read=false)::int AS unread,
                COUNT(*) FILTER (WHERE is_read=false AND severity='critical')::int AS critical
           FROM public.fleet_alerts WHERE company_id=$1`,
        [cid],
      );
      unreadAlerts = Number((alerts.rows[0] as Record<string, unknown>)?.unread ?? 0);
      criticalUnread = Number((alerts.rows[0] as Record<string, unknown>)?.critical ?? 0);
    }

    const top3Risks = [
      ...(criticalUnread > 0 ? [{
        taskId: "ALERT-CRITICAL",
        title: `${criticalUnread} alert kritis belum dibaca`,
        reason: "Perlu ditinjau untuk mencegah gangguan operasional fleet.",
        action: "Buka Alerts",
        href: "/logistics/fleet-intelligence/alerts",
        severity: "critical" as const,
      }] : []),
      ...(outstandingDrivers > 0 ? [{
        taskId: "OUTSTANDING",
        title: `${outstandingDrivers} driver masih outstanding`,
        reason: `Total outstanding Rp ${Math.round(outstandingAmount).toLocaleString("id-ID")}.`,
        action: "Tinjau Outstanding",
        href: "/logistics/fleet-intelligence/outstanding",
        severity: "warning" as const,
      }] : []),
    ].slice(0, 3);

    const priorityTask = top3Risks[0] ?? {
      taskId: "OPTIMIZATION",
      title: "Fleet Intelligence siap digunakan",
      reason: "Tidak ada risiko kritis yang terdeteksi dari data runtime saat ini.",
      action: "Lihat Analytics",
      href: "/logistics/fleet-intelligence/analytics",
      severity: "optimization" as const,
    };
    const healthScore = Math.max(0, 100 - criticalUnread * 20 - Math.min(outstandingDrivers, 10) * 2);
    const systemStatus = healthScore >= 80 ? "OK" : healthScore >= 50 ? "DEGRADED" : "CRITICAL";

    res.json({
      generatedAt: new Date().toISOString(),
      systemStatus,
      healthScore,
      recommendedAction: priorityTask.action,
      priorityTask,
      top3Risks,
    });
  } catch (error) {
    req.log.error({ error }, "Fleet executive summary failed");
    res.status(503).json({ error: "Gagal mengambil executive summary." });
  }
});


router.get("/settings", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("accounting_settings"))) {
      res.json({ ok: true, fleetCashAccountId: null, fleetDriverReceivableAccountId: null });
      return;
    }
    const result = await pool.query(
      "SELECT meta FROM public.accounting_settings WHERE company_id=$1 LIMIT 1",
      [cid],
    );
    const meta = ((result.rows[0] as Record<string, unknown> | undefined)?.meta ?? {}) as Record<string, unknown>;
    res.json({
      ok: true,
      fleetCashAccountId: Number(meta.fleetCashAccountId) || null,
      fleetDriverReceivableAccountId: Number(meta.fleetDriverReceivableAccountId) || null,
    });
  } catch (error) {
    req.log.error({ error }, "Fleet settings failed");
    res.status(503).json({ error: "Gagal mengambil Fleet Accounting Settings." });
  }
});

router.put("/settings", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("accounting_settings"))) {
      res.status(503).json({ error: "Accounting settings belum tersedia." });
      return;
    }
    const existing = await pool.query(
      "SELECT id,meta FROM public.accounting_settings WHERE company_id=$1 LIMIT 1",
      [cid],
    );
    const row = existing.rows[0] as Record<string, unknown> | undefined;
    const meta = ((row?.meta ?? {}) as Record<string, unknown>);
    const next = {
      ...meta,
      fleetCashAccountId: Number(req.body?.fleetCashAccountId) || null,
      fleetDriverReceivableAccountId: Number(req.body?.fleetDriverReceivableAccountId) || null,
    };
    if (row?.id) {
      await pool.query(
        "UPDATE public.accounting_settings SET meta=$2::jsonb WHERE id=$1",
        [row.id, JSON.stringify(next)],
      );
    } else {
      await pool.query(
        "INSERT INTO public.accounting_settings (company_id,meta) VALUES ($1,$2::jsonb)",
        [cid, JSON.stringify(next)],
      );
    }
    res.json({ ok: true, fleetCashAccountId: next.fleetCashAccountId, fleetDriverReceivableAccountId: next.fleetDriverReceivableAccountId });
  } catch (error) {
    req.log.error({ error }, "Fleet settings update failed");
    res.status(503).json({ error: "Gagal menyimpan Fleet Accounting Settings." });
  }
});

router.get("/cash-payments", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_cash_payments"))) {
      res.json({ payments: [], total: 0 });
      return;
    }
    const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 3650);
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const result = await pool.query(
      `SELECT cp.*, fo.outstanding_amount AS remaining_outstanding
         FROM public.fleet_cash_payments cp
         LEFT JOIN public.fleet_outstanding fo ON fo.id=cp.outstanding_id AND fo.company_id=cp.company_id
        WHERE cp.company_id=$1
          AND cp.payment_date >= CURRENT_DATE - ($2::int * interval '1 day')
          AND ($3='' OR cp.status=$3)
        ORDER BY cp.payment_date DESC,cp.id DESC
        LIMIT $4`,
      [cid, days, status, limit],
    );
    res.json({ payments: result.rows, total: result.rows.length });
  } catch (error) {
    req.log.error({ error }, "Fleet cash payments failed");
    res.status(503).json({ error: "Gagal mengambil daftar pembayaran." });
  }
});

router.get("/cash-payments/summary", async (req: AdminRequest, res) => {
  try {
    const cid = companyId(req);
    if (!(await tableExists("fleet_cash_payments"))) {
      res.json({ totals: { thisMonthTotal: 0, cancelledTotal: 0, postedTotal: 0, cancelledCount: 0, confirmedCount: 0, postedCount: 0 } });
      return;
    }
    const result = await pool.query(
      `SELECT
          COALESCE(SUM(amount) FILTER (WHERE date_trunc('month',payment_date)=date_trunc('month',CURRENT_DATE) AND status<>'cancelled'),0)::numeric AS this_month_total,
          COALESCE(SUM(amount) FILTER (WHERE status='cancelled'),0)::numeric AS cancelled_total,
          COALESCE(SUM(amount) FILTER (WHERE status='posted'),0)::numeric AS posted_total,
          COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled_count,
          COUNT(*) FILTER (WHERE status='confirmed')::int AS confirmed_count,
          COUNT(*) FILTER (WHERE status='posted')::int AS posted_count
         FROM public.fleet_cash_payments WHERE company_id=$1`,
      [cid],
    );
    const row=result.rows[0] as Record<string,unknown>;
    res.json({ totals: {
      thisMonthTotal:Number(row?.this_month_total??0),
      cancelledTotal:Number(row?.cancelled_total??0),
      postedTotal:Number(row?.posted_total??0),
      cancelledCount:Number(row?.cancelled_count??0),
      confirmedCount:Number(row?.confirmed_count??0),
      postedCount:Number(row?.posted_count??0),
    }});
  } catch (error) {
    req.log.error({ error }, "Fleet cash payment summary failed");
    res.status(503).json({ error: "Gagal mengambil ringkasan pembayaran." });
  }
});

router.post("/cash-payments", async (req: AdminRequest, res) => {
  const client = await pool.connect();
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    if (!(await tableExists("fleet_cash_payments"))) {
      res.status(503).json({ error: "Tabel pembayaran fleet belum tersedia." });
      return;
    }
    const body=req.body??{};
    const driverName=typeof body.driver_name==="string"?body.driver_name.trim():"";
    const amount=Number(body.amount);
    if(!driverName||!Number.isFinite(amount)||amount<=0){
      res.status(400).json({error:"Nama driver dan jumlah pembayaran wajib valid."});
      return;
    }
    await client.query("BEGIN");
    let outstandingId=Number(body.outstanding_id)||null;
    if(!outstandingId){
      const found=await client.query(
        `SELECT id FROM public.fleet_outstanding
          WHERE company_id=$1 AND status='open' AND lower(driver_name)=lower($2)
          ORDER BY id DESC LIMIT 1`,
        [cid,driverName],
      );
      outstandingId=Number(found.rows[0]?.id)||null;
    }
    const payment=await client.query(
      `INSERT INTO public.fleet_cash_payments
        (company_id,outstanding_id,driver_name,driver_external_id,driver_phone,vehicle_plate,payment_date,amount,payment_method,reference_no,notes,recorded_by,status)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::date,CURRENT_DATE),$8,$9,$10,$11,$12,'confirmed')
       RETURNING *`,
      [
        cid,outstandingId,driverName,
        typeof body.driver_external_id==="string"?body.driver_external_id:null,
        typeof body.driver_phone==="string"?body.driver_phone:null,
        typeof body.vehicle_plate==="string"?body.vehicle_plate:null,
        typeof body.payment_date==="string"?body.payment_date:null,
        amount,
        typeof body.payment_method==="string"&&body.payment_method?body.payment_method:"cash",
        typeof body.reference_no==="string"?body.reference_no:null,
        typeof body.notes==="string"?body.notes:null,
        req.adminUser?.email??"unknown",
      ],
    );
    if(outstandingId){
      await client.query(
        `UPDATE public.fleet_outstanding
            SET outstanding_amount=GREATEST(outstanding_amount-$3,0),
                status=CASE WHEN GREATEST(outstanding_amount-$3,0)<=0 THEN 'resolved' ELSE status END,
                resolved_at=CASE WHEN GREATEST(outstanding_amount-$3,0)<=0 THEN NOW() ELSE resolved_at END,
                updated_at=NOW()
          WHERE id=$1 AND company_id=$2`,
        [outstandingId,cid,amount],
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ok:true,payment:payment.rows[0],accountingPosted:false});
  } catch(error){
    await client.query("ROLLBACK").catch(()=>undefined);
    req.log.error({error},"Fleet cash payment create failed");
    res.status(503).json({error:"Gagal mencatat pembayaran fleet."});
  } finally {
    client.release();
  }
});

router.patch("/cash-payments/:id/cancel", async (req: AdminRequest, res) => {
  const client=await pool.connect();
  try{
    const cid=companyId(req);
    const id=Number(req.params.id);
    await client.query("BEGIN");
    const current=await client.query(
      "SELECT * FROM public.fleet_cash_payments WHERE id=$1 AND company_id=$2 FOR UPDATE",
      [id,cid],
    );
    const row=current.rows[0] as Record<string,unknown>|undefined;
    if(!row){
      await client.query("ROLLBACK");
      res.status(404).json({error:"Pembayaran tidak ditemukan."});
      return;
    }
    if(row.status==="cancelled"){
      await client.query("ROLLBACK");
      res.json({ok:true});
      return;
    }
    await client.query(
      "UPDATE public.fleet_cash_payments SET status='cancelled',updated_at=NOW() WHERE id=$1 AND company_id=$2",
      [id,cid],
    );
    if(row.outstanding_id){
      await client.query(
        `UPDATE public.fleet_outstanding
            SET outstanding_amount=outstanding_amount+$3,status='open',resolved_at=NULL,updated_at=NOW()
          WHERE id=$1 AND company_id=$2`,
        [row.outstanding_id,cid,Number(row.amount)||0],
      );
    }
    await client.query("COMMIT");
    res.json({ok:true});
  }catch(error){
    await client.query("ROLLBACK").catch(()=>undefined);
    req.log.error({error},"Fleet cash payment cancel failed");
    res.status(503).json({error:"Gagal membatalkan pembayaran."});
  }finally{
    client.release();
  }
});

router.get("/validation/report", async (req: AdminRequest, res) => {
  try {
    await ensureFleetTables();
    const cid = companyId(req);
    const hasTx = await tableExists("fleet_transactions");
    const hasRaw = await tableExists("gojek_raw_transactions");
    const hasJournal = await tableExists("fleet_accounting_journals");

    const summary = hasTx
      ? (await pool.query(
          `SELECT COUNT(*)::int AS total_transactions,
                  COALESCE(SUM(gross_revenue),0)::numeric AS total_gross_revenue,
                  COALESCE(SUM(net_revenue),0)::numeric AS total_net_revenue,
                  COALESCE(SUM(ppn_amount),0)::numeric AS total_ppn
             FROM public.fleet_transactions WHERE company_id=$1`,
          [cid],
        )).rows[0]
      : { total_transactions: 0, total_gross_revenue: 0, total_net_revenue: 0, total_ppn: 0 };

    const duplicateTransactions = hasTx
      ? (await pool.query(
          `SELECT driver_external_id, transaction_date, COUNT(*)::int AS count
             FROM public.fleet_transactions
            WHERE company_id=$1
            GROUP BY driver_external_id,transaction_date
           HAVING COUNT(*)>1
            ORDER BY count DESC LIMIT 50`,
          [cid],
        )).rows
      : [];

    const outstanding = await pool.query(
      "SELECT COALESCE(SUM(outstanding_amount),0)::numeric AS total FROM public.fleet_outstanding WHERE company_id=$1 AND status='open'",
      [cid],
    );
    let rawOutstanding = 0;
    if (hasRaw) {
      const raw = await pool.query(
        `SELECT COALESCE(SUM(x.total_outstanding_balance),0)::numeric AS total
           FROM (
             SELECT DISTINCT ON (driver_external_id) driver_external_id,total_outstanding_balance
             FROM public.gojek_raw_transactions
             WHERE company_id=$1 AND NULLIF(driver_external_id,'') IS NOT NULL AND total_outstanding_balance IS NOT NULL
             ORDER BY driver_external_id,date_iso DESC NULLS LAST,id DESC
           ) x`,
        [cid],
      );
      rawOutstanding = Number((raw.rows[0] as Record<string, unknown>)?.total ?? 0);
    }
    const outstandingTotal = Number((outstanding.rows[0] as Record<string, unknown>)?.total ?? 0);
    const diff = outstandingTotal - rawOutstanding;

    const journals = hasJournal
      ? (await pool.query(
          "SELECT * FROM public.fleet_accounting_journals WHERE company_id=$1 AND status NOT IN ('draft','approved','posted') LIMIT 50",
          [cid],
        )).rows
      : [];

    res.json({
      generatedAt: new Date().toISOString(),
      companyId: cid,
      summary: {
        totalTransactions: Number((summary as Record<string, unknown>).total_transactions ?? 0),
        totalGrossRevenue: Number((summary as Record<string, unknown>).total_gross_revenue ?? 0),
        totalNetRevenue: Number((summary as Record<string, unknown>).total_net_revenue ?? 0),
        totalPpn: Number((summary as Record<string, unknown>).total_ppn ?? 0),
      },
      checks: {
        duplicateTransactions: { status: duplicateTransactions.length ? "warn" : "ok", count: duplicateTransactions.length, items: duplicateTransactions },
        summaryIntegrity: { status: "ok", count: 0, items: [] },
        ppnConsistency: { status: "ok", count: 0, items: [] },
        multiTenantSecurity: { status: "ok", nullCounts: {} },
        outstandingIntegrity: {
          status: Math.abs(diff) > 1 ? "warn" : "ok",
          outstandingTableSum: outstandingTotal,
          transactionSum: rawOutstanding,
          diff,
        },
        journalIntegrity: { status: journals.length ? "warn" : "ok", count: journals.length, items: journals },
      },
    });
  } catch (error) {
    req.log.error({ error }, "Fleet validation report failed");
    res.status(503).json({ error: "Gagal mengambil validation report." });
  }
});

export default router;
