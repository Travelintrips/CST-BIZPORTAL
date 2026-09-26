import { pool } from "@workspace/db";

type ReminderRow = {
  id: number;
  driver_name: string;
  driver_phone: string | null;
  vehicle_plate: string | null;
  outstanding_amount: string | number;
};

export type FleetReminderSweepResult = {
  companyId: number;
  eligible: number;
  sent: number;
  failed: number;
  skippedSuppressed: number;
  skippedNoPhone: number;
};

function normalizePhone(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("62")) return digits;
  if (digits.startsWith("0")) return "62" + digits.slice(1);
  return "62" + digits;
}

function formatIdr(value: unknown): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

async function getFonnteToken(): Promise<string> {
  const envToken = process.env.FONNTE_TOKEN?.trim();
  if (envToken) return envToken;
  try {
    const result = await pool.query<{ value: string }>(
      `SELECT value
         FROM public.portal_content
        WHERE key='fonnte_token'
          AND trim(COALESCE(value,'')) <> ''
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`,
    );
    return result.rows[0]?.value?.trim() ?? "";
  } catch {
    return "";
  }
}

async function getFonnteDeviceProfile(token: string): Promise<{ device: string | null; deviceStatus: string | null }> {
  try {
    const response = await fetch("https://api.fonnte.com/device", {
      method: "POST",
      headers: { Authorization: token },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => null) as {
      status?: boolean | string;
      device?: string;
      device_status?: string;
    } | null;
    if (!response.ok || payload?.status === false || payload?.status === "false") {
      return { device: null, deviceStatus: null };
    }
    return {
      device: payload?.device ? normalizePhone(payload.device) : null,
      deviceStatus: payload?.device_status ? String(payload.device_status) : null,
    };
  } catch {
    return { device: null, deviceStatus: null };
  }
}

async function sendFonnte(target: string, message: string, token: string): Promise<{ messageId: string | null }> {
  const response = await fetch("https://api.fonnte.com/send", {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ target, message }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as {
    status?: boolean | string;
    reason?: string;
    message?: string;
  } | null;
  const rejected = payload?.status === false || payload?.status === "false";
  if (!response.ok || rejected) {
    throw new Error(payload?.reason ?? payload?.message ?? `Fonnte returned ${response.status}`);
  }
  const rawId = (payload as Record<string, unknown> | null)?.id
    ?? (payload as Record<string, unknown> | null)?.message_id
    ?? (payload as Record<string, unknown> | null)?.requestid
    ?? null;
  return { messageId: rawId == null ? null : String(rawId) };
}

function reminderMessage(row: ReminderRow): string {
  const plate = String(row.vehicle_plate ?? "").trim();
  return [
    `Yth. Bapak/Ibu ${row.driver_name},`,
    "",
    "Pengingat outstanding driver GoCar - PT Cahaya Sejati Teknologi.",
    plate ? `Kendaraan: ${plate}` : null,
    `Outstanding saat ini: ${formatIdr(row.outstanding_amount)}`,
    "",
    "Mohon melakukan penyelesaian outstanding sesuai ketentuan yang berlaku.",
    "Jika pembayaran sudah dilakukan, abaikan pesan ini dan simpan bukti pembayaran untuk verifikasi.",
    "",
    "Terima kasih.",
    "PT Cahaya Sejati Teknologi",
  ].filter(Boolean).join("\n");
}

export async function sendFleetOutstandingReminders(args: {
  companyId: number;
  actor?: string;
  suppressHours?: number;
  ids?: number[];
  sendType?: "manual" | "selected" | "auto";
}): Promise<FleetReminderSweepResult> {
  const companyId = args.companyId;
  const suppressHours = Math.max(1, Math.min(168, Number(args.suppressHours) || 24));
  const sendType = args.sendType ?? "manual";
  const ids = Array.isArray(args.ids) ? args.ids.filter((id) => Number.isSafeInteger(id) && id > 0) : [];
  const token = await getFonnteToken();
  if (!token) throw new Error("FONNTE_TOKEN belum dikonfigurasi.");

  const deviceProfile = await getFonnteDeviceProfile(token);
  const senderDevice = deviceProfile.device;

  const params: unknown[] = [companyId, suppressHours];
  let idFilter = "";
  if (ids.length) {
    params.push(ids);
    idFilter = ` AND o.id = ANY($${params.length}::int[])`;
  }

  const result = await pool.query<ReminderRow & { suppressed: boolean }>(
    `SELECT o.id,o.driver_name,
            COALESCE(NULLIF(d.phone,''),NULLIF(o.driver_phone,'')) AS driver_phone,
            COALESCE(NULLIF(d.vehicle_plate,''),NULLIF(o.vehicle_plate,'')) AS vehicle_plate,
            o.outstanding_amount,
            EXISTS (
              SELECT 1
                FROM public.fleet_wa_logs l
               WHERE l.company_id=o.company_id
                 AND l.outstanding_id=o.id
                 AND l.status='sent'
                 AND l.sent_at >= NOW() - ($2::int * interval '1 hour')
            ) AS suppressed
       FROM public.fleet_outstanding o
       JOIN public.fleet_drivers d
         ON d.id=o.driver_id
        AND d.company_id=o.company_id::text
      WHERE o.company_id=$1
        AND o.status='open'
        AND o.outstanding_amount > 0
        AND d.status='active'
        AND NULLIF(d.vehicle_plate,'') IS NOT NULL
        ${idFilter}
      ORDER BY o.outstanding_amount DESC,o.id`,
    params,
  );

  let sent = 0;
  let failed = 0;
  let skippedSuppressed = 0;
  let skippedNoPhone = 0;

  for (const row of result.rows) {
    if (row.suppressed) {
      skippedSuppressed += 1;
      continue;
    }
    const phone = normalizePhone(row.driver_phone);
    if (!phone) {
      skippedNoPhone += 1;
      continue;
    }
    const message = reminderMessage(row);
    try {
      const provider = await sendFonnte(phone, message, token);
      await pool.query(
        `INSERT INTO public.fleet_wa_logs
          (company_id,outstanding_id,driver_name,driver_phone,vehicle_plate,outstanding_amount,message,sent_by,send_type,status,sender_device,provider_message_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'sent',$10,$11)`,
        [companyId,row.id,row.driver_name,phone,row.vehicle_plate,row.outstanding_amount,message,args.actor ?? "system",sendType,senderDevice,provider.messageId],
      );
      await pool.query(
        `UPDATE public.fleet_outstanding
            SET last_wa_sent_at=NOW(),is_notified=true,updated_at=NOW()
          WHERE id=$1 AND company_id=$2`,
        [row.id,companyId],
      );
      sent += 1;
    } catch (error) {
      failed += 1;
      await pool.query(
        `INSERT INTO public.fleet_wa_logs
          (company_id,outstanding_id,driver_name,driver_phone,vehicle_plate,outstanding_amount,message,sent_by,send_type,status,sender_device,error_detail)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'failed',$10,$11)`,
        [companyId,row.id,row.driver_name,phone,row.vehicle_plate,row.outstanding_amount,message,args.actor ?? "system",sendType,senderDevice,error instanceof Error ? error.message : String(error)],
      ).catch(() => undefined);
    }
  }

  return {
    companyId,
    eligible: result.rows.length,
    sent,
    failed,
    skippedSuppressed,
    skippedNoPhone,
    senderDevice,
    deviceStatus: deviceProfile.deviceStatus,
  } as FleetReminderSweepResult & { senderDevice: string | null; deviceStatus: string | null };
}

export async function runFleetAutoReminderSweep(): Promise<FleetReminderSweepResult[]> {
  const token = await getFonnteToken();
  if (!token) return [];

  const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const hourWib = nowWib.getUTCHours();
  const dateWib = nowWib.toISOString().slice(0,10);

  const settings = await pool.query<{
    company_id: number;
    fleet_auto_blast_hour: number | null;
    fleet_auto_blast_last_run: string | Date | null;
  }>(
    `SELECT company_id,fleet_auto_blast_hour,fleet_auto_blast_last_run
       FROM public.accounting_settings
      WHERE fleet_auto_blast_enabled=true
        AND company_id IS NOT NULL`,
  );

  const output: FleetReminderSweepResult[] = [];
  for (const row of settings.rows) {
    const configuredHour = Number(row.fleet_auto_blast_hour ?? 8);
    if (configuredHour !== hourWib) continue;
    const lastRunDate = row.fleet_auto_blast_last_run
      ? new Date(row.fleet_auto_blast_last_run).toISOString().slice(0,10)
      : null;
    if (lastRunDate === dateWib) continue;

    const claimed = await pool.query(
      `UPDATE public.accounting_settings
          SET fleet_auto_blast_last_run=NOW(),updated_at=NOW()
        WHERE company_id=$1
          AND fleet_auto_blast_enabled=true
          AND (
            fleet_auto_blast_last_run IS NULL
            OR (fleet_auto_blast_last_run AT TIME ZONE 'Asia/Jakarta')::date < (NOW() AT TIME ZONE 'Asia/Jakarta')::date
          )
        RETURNING company_id`,
      [row.company_id],
    );
    if (!claimed.rowCount) continue;

    const result = await sendFleetOutstandingReminders({
      companyId: Number(row.company_id),
      actor: "fleet-auto-reminder",
      suppressHours: 20,
      sendType: "auto",
    });
    output.push(result);
  }
  return output;
}
