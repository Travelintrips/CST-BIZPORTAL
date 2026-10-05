import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { pool } from "@workspace/db";

const router = Router();

function secureEqual(a: string, b: string): boolean {
  const left=Buffer.from(a);
  const right=Buffer.from(b);
  if(left.length!==right.length) return false;
  return timingSafeEqual(left,right);
}

function requireFleetIntegration(req: Request,res: Response,next: NextFunction) {
  const configured=String(process.env.FLEET_INTEGRATION_TOKEN ?? "").trim();
  if(!configured) {
    res.status(503).json({error:"Fleet integration is not configured."});
    return;
  }
  const auth=String(req.header("authorization") ?? "");
  const supplied=auth.startsWith("Bearer ")?auth.slice(7).trim():"";
  if(!supplied||!secureEqual(supplied,configured)) {
    res.status(401).json({error:"Unauthorized"});
    return;
  }
  next();
}

router.use(requireFleetIntegration);

function positiveInt(value: unknown): number | null {
  const n=Number(value);
  return Number.isSafeInteger(n)&&n>0?n:null;
}

function positiveAmount(value: unknown): number | null {
  const n=Number(value);
  return Number.isFinite(n)&&n>0?n:null;
}

router.post("/cash-payments", async (req,res) => {
  const companyId=positiveInt(req.body?.companyId);
  const paymentId=positiveInt(req.body?.paymentId);
  const amount=positiveAmount(req.body?.amount);
  const cashId=positiveInt(req.body?.fleetCashAccountId);
  const receivableId=positiveInt(req.body?.fleetDriverReceivableAccountId);
  const journalId=positiveInt(req.body?.journalId);
  const driverName=typeof req.body?.driverName==="string"?req.body.driverName.trim():"";
  const paymentDate=typeof req.body?.paymentDate==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(req.body.paymentDate)
    ? req.body.paymentDate
    : "";
  const referenceNo=typeof req.body?.referenceNo==="string"?req.body.referenceNo.trim():"";
  const actor=typeof req.body?.actor==="string"?req.body.actor.trim():null;

  if(!companyId||!paymentId||!amount||!cashId||!receivableId||!journalId||!driverName||!paymentDate) {
    res.status(400).json({error:"Fleet cash payment payload tidak lengkap/valid."});
    return;
  }

  const client=await pool.connect();
  try {
    await client.query("BEGIN");

    const existing=await client.query(
      `SELECT id,status::text FROM public.accounting_entries
        WHERE company_id=$1 AND source='fleet_cash_payment' AND source_id=$2
        LIMIT 1`,
      [companyId,paymentId],
    );
    if(existing.rows[0]?.id) {
      await client.query("ROLLBACK");
      res.json({entryId:Number(existing.rows[0].id),idempotent:true,status:existing.rows[0].status});
      return;
    }

    const accounts=await client.query(
      `SELECT id,type::text
         FROM public.chart_of_accounts
        WHERE company_id=$1 AND id=ANY($2::int[])
          AND COALESCE(is_active,true)=true
          AND COALESCE(is_postable,true)=true
          AND COALESCE(status,'ACTIVE')='ACTIVE'`,
      [companyId,[cashId,receivableId]],
    );
    if(accounts.rowCount!==2||accounts.rows.some((row:{type:string})=>row.type!=="asset")) {
      await client.query("ROLLBACK");
      res.status(409).json({error:"COA Fleet Cash/Piutang tidak valid, aktif, postable, atau bukan asset."});
      return;
    }

    const journal=await client.query(
      `SELECT id FROM public.accounting_journals
        WHERE company_id=$1 AND id=$2 AND COALESCE(is_active,true)=true
        LIMIT 1`,
      [companyId,journalId],
    );
    if(!journal.rows[0]) {
      await client.query("ROLLBACK");
      res.status(409).json({error:"Journal Fleet tidak valid/aktif untuk company ini."});
      return;
    }

    const year=paymentDate.slice(0,4);
    const entryNumber=`FLEET-${companyId}-${year}-${String(paymentId).padStart(8,"0")}`;
    const ref=referenceNo||`FCP-${paymentId}`;
    const description=`Pembayaran driver fleet - ${driverName}`;

    const entry=await client.query(
      `INSERT INTO public.accounting_entries
        (entry_number,journal_id,date,ref,description,status,source,source_id,total_debit,total_credit,
         created_by_id,company_id,source_module,source_schema,source_table,entry_status)
       VALUES($1,$2,$3::date,$4,$5,'draft','fleet_cash_payment',$6,$7,$7,$8,$9,
              'fleet_intelligence','public','fleet_cash_payments','DRAFT')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [entryNumber,journalId,paymentDate,ref,description,paymentId,amount,actor,companyId],
    );

    let entryId=Number(entry.rows[0]?.id);
    if(!entryId) {
      const raced=await client.query(
        "SELECT id FROM public.accounting_entries WHERE company_id=$1 AND source='fleet_cash_payment' AND source_id=$2 LIMIT 1",
        [companyId,paymentId],
      );
      entryId=Number(raced.rows[0]?.id);
      if(!entryId) throw new Error("Gagal membuat jurnal Fleet Cash Payment.");
      await client.query("ROLLBACK");
      res.json({entryId,idempotent:true});
      return;
    }

    await client.query(
      `INSERT INTO public.accounting_entry_lines
        (entry_id,account_id,description,debit,credit,company_id,source_module,source_table,source_id)
       VALUES
        ($1,$2,$3,$4,0,$5,'fleet_intelligence','fleet_cash_payments',$6),
        ($1,$7,$8,0,$4,$5,'fleet_intelligence','fleet_cash_payments',$6)`,
      [entryId,cashId,`Kas masuk pembayaran driver - ${driverName}`,amount,companyId,paymentId,receivableId,`Pelunasan piutang driver - ${driverName}`],
    );

    await client.query(
      "UPDATE public.accounting_entries SET status='posted',entry_status='POSTED',posted_at=NOW() WHERE id=$1 AND status='draft'",
      [entryId],
    );
    await client.query("COMMIT");
    res.status(201).json({entryId,idempotent:false,status:"posted"});
  } catch(error) {
    await client.query("ROLLBACK").catch(()=>undefined);
    req.log.error({error,companyId,paymentId},"Fleet integration cash posting failed");
    res.status(503).json({error:error instanceof Error?error.message:"Fleet accounting posting failed."});
  } finally {
    client.release();
  }
});

router.post("/cash-payments/reverse", async (req,res) => {
  const companyId=positiveInt(req.body?.companyId);
  const paymentId=positiveInt(req.body?.paymentId);
  const originalEntryId=positiveInt(req.body?.originalEntryId);
  const actor=typeof req.body?.actor==="string"?req.body.actor.trim():null;
  const driverName=typeof req.body?.driverName==="string"?req.body.driverName.trim():"Driver";

  if(!companyId||!paymentId||!originalEntryId) {
    res.status(400).json({error:"Fleet reversal payload tidak valid."});
    return;
  }

  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const existing=await client.query(
      "SELECT id,status::text FROM public.accounting_entries WHERE company_id=$1 AND source='reversal' AND source_id=$2 LIMIT 1",
      [companyId,originalEntryId],
    );
    if(existing.rows[0]?.id) {
      await client.query("ROLLBACK");
      res.json({entryId:Number(existing.rows[0].id),idempotent:true,status:existing.rows[0].status});
      return;
    }

    const original=await client.query(
      `SELECT id,journal_id,total_debit,total_credit
         FROM public.accounting_entries
        WHERE id=$1 AND company_id=$2 AND source='fleet_cash_payment' AND source_id=$3
          AND status::text='posted'
        FOR UPDATE`,
      [originalEntryId,companyId,paymentId],
    );
    if(!original.rows[0]) {
      await client.query("ROLLBACK");
      res.status(409).json({error:"Jurnal Fleet original tidak ditemukan atau belum posted."});
      return;
    }

    const lines=await client.query(
      `SELECT account_id,description,debit,credit
         FROM public.accounting_entry_lines
        WHERE entry_id=$1 AND company_id=$2
        ORDER BY id`,
      [originalEntryId,companyId],
    );
    if(!lines.rowCount) throw new Error("Jurnal Fleet original tidak memiliki lines.");

    const year=String(new Date().getFullYear());
    const entryNumber=`FLEET-R-${companyId}-${year}-${String(paymentId).padStart(8,"0")}`;
    const entry=await client.query(
      `INSERT INTO public.accounting_entries
        (entry_number,journal_id,date,ref,description,status,source,source_id,total_debit,total_credit,
         created_by_id,company_id,source_module,source_schema,source_table,previous_entry_id,entry_status)
       VALUES($1,$2,CURRENT_DATE,$3,$4,'draft','reversal',$5,$6,$7,$8,$9,
              'fleet_intelligence','public','fleet_cash_payments',$5,'DRAFT')
       ON CONFLICT DO NOTHING RETURNING id`,
      [entryNumber,original.rows[0].journal_id,`VOID-FCP-${paymentId}`,`Pembatalan pembayaran driver fleet - ${driverName}`,
       originalEntryId,original.rows[0].total_credit,original.rows[0].total_debit,actor,companyId],
    );
    let entryId=Number(entry.rows[0]?.id);
    if(!entryId) {
      const raced=await client.query(
        "SELECT id FROM public.accounting_entries WHERE company_id=$1 AND source='reversal' AND source_id=$2 LIMIT 1",
        [companyId,originalEntryId],
      );
      entryId=Number(raced.rows[0]?.id);
      if(!entryId) throw new Error("Gagal membuat jurnal reversal Fleet.");
      await client.query("ROLLBACK");
      res.json({entryId,idempotent:true});
      return;
    }

    for(const line of lines.rows as Array<{account_id:number;description:string;debit:number|string;credit:number|string}>) {
      await client.query(
        `INSERT INTO public.accounting_entry_lines
          (entry_id,account_id,description,debit,credit,company_id,source_module,source_table,source_id)
         VALUES($1,$2,$3,$4,$5,$6,'fleet_intelligence','fleet_cash_payments',$7)`,
        [entryId,line.account_id,`Reversal: ${line.description||driverName}`,Number(line.credit)||0,Number(line.debit)||0,companyId,originalEntryId],
      );
    }

    await client.query(
      "UPDATE public.accounting_entries SET status='posted',entry_status='POSTED',posted_at=NOW() WHERE id=$1 AND status='draft'",
      [entryId],
    );
    await client.query("COMMIT");
    res.status(201).json({entryId,idempotent:false,status:"posted"});
  } catch(error) {
    await client.query("ROLLBACK").catch(()=>undefined);
    req.log.error({error,companyId,paymentId,originalEntryId},"Fleet integration reversal failed");
    res.status(503).json({error:error instanceof Error?error.message:"Fleet accounting reversal failed."});
  } finally {
    client.release();
  }
});

export default router;
