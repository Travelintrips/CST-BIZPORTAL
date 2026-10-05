import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "@workspace/db";

const router = Router();

function configuredToken(): string {
  return String(process.env.FLEET_FINANCE_SERVICE_TOKEN ?? "").trim();
}

function safeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireFleetFinanceService(req: Request, res: Response, next: NextFunction): void {
  const expected = configuredToken();
  if (!expected) {
    res.status(503).json({ error: "Fleet Finance integration belum dikonfigurasi." });
    return;
  }

  const authorization = req.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const supplied = match?.[1]?.trim() ?? "";
  if (!supplied || !safeTokenEqual(supplied, expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function parsePositiveInt(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function requireIdempotencyKey(req: Request, res: Response): string | null {
  const key = String(req.get("idempotency-key") ?? "").trim();
  if (key.length < 8 || key.length > 200) {
    res.status(400).json({ error: "Idempotency-Key wajib 8-200 karakter." });
    return null;
  }
  return key;
}

async function resolvePostingSettings(client: any, companyId: number) {
  const result = await client.query(
    `SELECT s.fleet_cash_account_id,s.fleet_driver_receivable_account_id,
            COALESCE(
              s.cash_journal_id,
              s.bank_journal_id,
              (SELECT id
                 FROM public.accounting_journals j
                WHERE j.company_id=$1
                  AND COALESCE(j.is_active,true)=true
                ORDER BY id
                LIMIT 1)
            ) AS journal_id
       FROM public.accounting_settings s
      WHERE s.company_id=$1
      LIMIT 1`,
    [companyId],
  );

  const row = result.rows[0] as Record<string, unknown> | undefined;
  const cashId = Number(row?.fleet_cash_account_id);
  const receivableId = Number(row?.fleet_driver_receivable_account_id);
  const journalId = Number(row?.journal_id);
  if (!cashId || !receivableId || !journalId) {
    throw new Error("Fleet Cash Payment COA/journal belum dikonfigurasi.");
  }

  const accounts = await client.query(
    `SELECT id
       FROM public.chart_of_accounts
      WHERE company_id=$1
        AND id=ANY($2::int[])
        AND COALESCE(is_active,true)=true
        AND COALESCE(is_postable,true)=true
        AND COALESCE(status,'ACTIVE')='ACTIVE'`,
    [companyId, [cashId, receivableId]],
  );
  if (accounts.rowCount !== 2) {
    throw new Error("COA Fleet Cash Payment tidak valid atau tidak postable.");
  }

  return { cashId, receivableId, journalId };
}

async function postCashPayment(client: any, args: {
  paymentId: number;
  companyId: number;
  amount: number;
  driverName: string;
  paymentDate: string;
  referenceNo?: string | null;
  actor?: string | null;
}) {
  const existing = await client.query(
    `SELECT id,status::text
       FROM public.accounting_entries
      WHERE company_id=$1
        AND source='fleet_cash_payment'
        AND source_id=$2
      LIMIT 1`,
    [args.companyId, args.paymentId],
  );
  if (existing.rows[0]?.id) {
    return { entryId: Number(existing.rows[0].id), idempotent: true };
  }

  const settings = await resolvePostingSettings(client, args.companyId);
  const year = String(args.paymentDate || new Date().toISOString()).slice(0, 4);
  const entryNumber = `FLEET-${args.companyId}-${year}-${String(args.paymentId).padStart(8, "0")}`;
  const ref = args.referenceNo?.trim() || `FCP-${args.paymentId}`;
  const description = `Pembayaran driver fleet - ${args.driverName}`;

  const entry = await client.query(
    `INSERT INTO public.accounting_entries
      (entry_number,journal_id,date,ref,description,status,source,source_id,total_debit,total_credit,
       created_by_id,company_id,source_module,source_schema,source_table,entry_status)
     VALUES($1,$2,$3::date,$4,$5,'draft','fleet_cash_payment',$6,$7,$7,$8,$9,
            'fleet_intelligence','public','fleet_cash_payments','DRAFT')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      entryNumber,
      settings.journalId,
      args.paymentDate,
      ref,
      description,
      args.paymentId,
      args.amount,
      args.actor ?? null,
      args.companyId,
    ],
  );

  let entryId = Number(entry.rows[0]?.id);
  if (!entryId) {
    const raced = await client.query(
      `SELECT id
         FROM public.accounting_entries
        WHERE company_id=$1
          AND source='fleet_cash_payment'
          AND source_id=$2
        LIMIT 1`,
      [args.companyId, args.paymentId],
    );
    entryId = Number(raced.rows[0]?.id);
    if (!entryId) throw new Error("Gagal membuat jurnal Fleet Cash Payment.");
    return { entryId, idempotent: true };
  }

  await client.query(
    `INSERT INTO public.accounting_entry_lines
      (entry_id,account_id,description,debit,credit,company_id,source_module,source_table,source_id)
     VALUES
      ($1,$2,$3,$4,0,$5,'fleet_intelligence','fleet_cash_payments',$6),
      ($1,$7,$8,0,$4,$5,'fleet_intelligence','fleet_cash_payments',$6)`,
    [
      entryId,
      settings.cashId,
      `Kas masuk pembayaran driver - ${args.driverName}`,
      args.amount,
      args.companyId,
      args.paymentId,
      settings.receivableId,
      `Pelunasan piutang driver - ${args.driverName}`,
    ],
  );

  await client.query(
    `UPDATE public.accounting_entries
        SET status='posted',entry_status='POSTED',posted_at=NOW()
      WHERE id=$1 AND status='draft'`,
    [entryId],
  );

  return { entryId, idempotent: false };
}

async function reverseCashPayment(client: any, args: {
  paymentId: number;
  originalEntryId: number;
  companyId: number;
  amount: number;
  driverName: string;
  actor?: string | null;
}) {
  const existing = await client.query(
    `SELECT id
       FROM public.accounting_entries
      WHERE company_id=$1
        AND source='reversal'
        AND source_id=$2
      LIMIT 1`,
    [args.companyId, args.originalEntryId],
  );
  if (existing.rows[0]?.id) {
    return { entryId: Number(existing.rows[0].id), idempotent: true };
  }

  const settings = await resolvePostingSettings(client, args.companyId);
  const year = new Date().getFullYear();
  const entryNumber = `FLEET-R-${args.companyId}-${year}-${String(args.paymentId).padStart(8, "0")}`;
  const ref = `VOID-FCP-${args.paymentId}`;
  const description = `Pembatalan pembayaran driver fleet - ${args.driverName}`;

  const entry = await client.query(
    `INSERT INTO public.accounting_entries
      (entry_number,journal_id,date,ref,description,status,source,source_id,total_debit,total_credit,
       created_by_id,company_id,source_module,source_schema,source_table,previous_entry_id,entry_status)
     VALUES($1,$2,CURRENT_DATE,$3,$4,'draft','reversal',$5,$6,$6,$7,$8,
            'fleet_intelligence','public','fleet_cash_payments',$5,'DRAFT')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      entryNumber,
      settings.journalId,
      ref,
      description,
      args.originalEntryId,
      args.amount,
      args.actor ?? null,
      args.companyId,
    ],
  );

  let entryId = Number(entry.rows[0]?.id);
  if (!entryId) {
    const raced = await client.query(
      `SELECT id
         FROM public.accounting_entries
        WHERE company_id=$1
          AND source='reversal'
          AND source_id=$2
        LIMIT 1`,
      [args.companyId, args.originalEntryId],
    );
    entryId = Number(raced.rows[0]?.id);
    if (!entryId) throw new Error("Gagal membuat jurnal reversal Fleet Cash Payment.");
    return { entryId, idempotent: true };
  }

  await client.query(
    `INSERT INTO public.accounting_entry_lines
      (entry_id,account_id,description,debit,credit,company_id,source_module,source_table,source_id)
     VALUES
      ($1,$2,$3,$4,0,$5,'fleet_intelligence','fleet_cash_payments',$6),
      ($1,$7,$8,0,$4,$5,'fleet_intelligence','fleet_cash_payments',$6)`,
    [
      entryId,
      settings.receivableId,
      `Reversal piutang driver - ${args.driverName}`,
      args.amount,
      args.companyId,
      args.originalEntryId,
      settings.cashId,
      `Reversal kas pembayaran driver - ${args.driverName}`,
    ],
  );

  await client.query(
    "UPDATE public.accounting_entries SET status='posted',entry_status='POSTED',posted_at=NOW() WHERE id=$1 AND status='draft'",
    [entryId],
  );

  return { entryId, idempotent: false };
}

router.use(requireFleetFinanceService);

router.get("/companies/:companyId/accounting-settings", async (req, res) => {
  const companyId = parsePositiveInt(req.params.companyId);
  if (!companyId) {
    res.status(400).json({ error: "companyId tidak valid." });
    return;
  }

  try {
    const client = await pool.connect();
    try {
      const settings = await resolvePostingSettings(client, companyId);
      res.json({
        fleetCashAccountId: settings.cashId,
        fleetDriverReceivableAccountId: settings.receivableId,
        journalId: settings.journalId,
      });
    } finally {
      client.release();
    }
  } catch (error) {
    req.log.error({ error, companyId }, "Fleet Finance settings integration failed");
    const message = error instanceof Error ? error.message : "Fleet Finance settings unavailable";
    res.status(message.includes("belum dikonfigurasi") ? 409 : 503).json({ error: message });
  }
});

router.post("/cash-payments", async (req, res) => {
  const key = requireIdempotencyKey(req, res);
  if (!key) return;

  const companyId = parsePositiveInt(req.body?.companyId);
  const paymentId = parsePositiveInt(req.body?.paymentId);
  const amount = Number(req.body?.amount);
  const driverName = typeof req.body?.driverName === "string" ? req.body.driverName.trim() : "";
  const paymentDate = typeof req.body?.paymentDate === "string" ? req.body.paymentDate.trim() : "";
  if (!companyId || !paymentId || !Number.isFinite(amount) || amount <= 0 || !driverName || !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
    res.status(400).json({ error: "Payload Fleet cash payment tidak valid." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await postCashPayment(client, {
      companyId,
      paymentId,
      amount,
      driverName,
      paymentDate,
      referenceNo: typeof req.body?.referenceNo === "string" ? req.body.referenceNo : null,
      actor: typeof req.body?.actor === "string" ? req.body.actor : "fleet-service",
    });
    await client.query("COMMIT");
    res.status(result.idempotent ? 200 : 201).json({ ...result, idempotencyKey: key });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    req.log.error({ error, companyId, paymentId }, "Fleet cash payment finance integration failed");
    const message = error instanceof Error ? error.message : "Fleet cash payment posting failed";
    res.status(message.includes("belum dikonfigurasi") || message.includes("tidak valid") ? 409 : 503).json({ error: message });
  } finally {
    client.release();
  }
});

router.post("/cash-payments/reverse", async (req, res) => {
  const key = requireIdempotencyKey(req, res);
  if (!key) return;

  const companyId = parsePositiveInt(req.body?.companyId);
  const paymentId = parsePositiveInt(req.body?.paymentId);
  const originalEntryId = parsePositiveInt(req.body?.originalEntryId);
  const amount = Number(req.body?.amount);
  const driverName = typeof req.body?.driverName === "string" ? req.body.driverName.trim() : "";
  if (!companyId || !paymentId || !originalEntryId || !Number.isFinite(amount) || amount <= 0 || !driverName) {
    res.status(400).json({ error: "Payload Fleet reversal tidak valid." });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await reverseCashPayment(client, {
      companyId,
      paymentId,
      originalEntryId,
      amount,
      driverName,
      actor: typeof req.body?.actor === "string" ? req.body.actor : "fleet-service",
    });
    await client.query("COMMIT");
    res.status(result.idempotent ? 200 : 201).json({ ...result, idempotencyKey: key });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    req.log.error({ error, companyId, paymentId, originalEntryId }, "Fleet cash payment reversal integration failed");
    const message = error instanceof Error ? error.message : "Fleet reversal posting failed";
    res.status(message.includes("belum dikonfigurasi") || message.includes("tidak valid") ? 409 : 503).json({ error: message });
  } finally {
    client.release();
  }
});

export default router;
