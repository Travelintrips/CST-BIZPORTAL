import { sql } from "drizzle-orm";
import type { DbClient } from "../accounting.js";

/** Read-only preflight. This is NOT authorization to reverse or post journals. */
export type PostedUnlinkedCohort = {
  mutationId: number;
  settlementDate: string;
  paymentIds: number[];
  expectedNet: number;
};
export type PostedUnlinkedCorrectionInput = {
  batchId: number;
  journalId: number;
  originalPaymentIds: number[];
  cohorts: [PostedUnlinkedCohort, PostedUnlinkedCohort];
};

function ensure(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error("QRIS_CORRECTION_PREFLIGHT: " + message);
}
function posInt(n: number): number {
  ensure(Number.isSafeInteger(n) && n > 0, "positive integer identity required");
  return n;
}
function sameSet(a: number[], b: number[]): boolean {
  return [...a].sort((x,y)=>x-y).join(",") === [...b].sort((x,y)=>x-y).join(",");
}
function nums(values: number[]) {
  return sql.join(values.map((id) => sql`${id}`), sql`, `);
}
function num(value: unknown): number {
  const result=Number(value);
  ensure(Number.isFinite(result), "financial value invalid");
  return result;
}

export async function preflightPostedUnlinkedCorrection(
  client: DbClient,
  request: PostedUnlinkedCorrectionInput,
) {
  const batchId=posInt(request.batchId);
  const journalId=posInt(request.journalId);
  ensure(Array.isArray(request.cohorts) && request.cohorts.length===2, "exactly two cohorts required");
  const original=request.originalPaymentIds.map(posInt);
  const cohorts=request.cohorts.map((c)=>({
    mutationId:posInt(c.mutationId),
    settlementDate:c.settlementDate,
    paymentIds:c.paymentIds.map(posInt),
    expectedNet:num(c.expectedNet),
  }));
  const all=cohorts.flatMap((c)=>c.paymentIds);
  ensure(original.length>0 && all.length>0, "payments missing");
  ensure(new Set(original).size===original.length && new Set(all).size===all.length,
    "duplicate payment or overlap");
  ensure(original.every((id)=>all.includes(id)), "historical payment omitted");
  ensure(new Set(cohorts.map((c)=>c.mutationId)).size===2, "bank mutation reused");
  ensure(cohorts.every((c)=>c.paymentIds.length>0 && c.expectedNet>0
    && /^\d{4}-\d{2}-\d{2}$/.test(c.settlementDate)), "cohort identity invalid");

  return client.transaction(async (tx)=>{
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const batchQuery=await tx.execute(sql`
      SELECT b.id,b.status,b.company_id,b.provider_code,b.bank_account_id,
             b.settlement_date,b.gross_amount,b.mdr_amount,b.net_amount,
             b.bank_mutation_id,b.canonical_bank_mutation_id,
             j.id AS journal_id,j.status AS journal_status,j.journal_type,
             j.is_reversal,j.settlement_batch_id
      FROM sport_center.payment_settlement_batches b
      JOIN sport_center.accounting_journals j ON j.id=b.settlement_journal_id
      WHERE b.id=${batchId}
    `);
    const batch=batchQuery.rows[0] as Record<string,unknown>|undefined;
    ensure(batch && batch.status==="posted" && batch.bank_mutation_id==null
      && batch.canonical_bank_mutation_id==null && num(batch.journal_id)===journalId
      && batch.journal_status==="posted" && batch.journal_type==="settlement"
      && batch.is_reversal===false && num(batch.settlement_batch_id)===batchId,
      "original batch must be posted, unlinked, and journal-backed");
    const reversal=await tx.execute(sql`
      SELECT id FROM sport_center.accounting_journals
      WHERE reversal_of_id=${journalId} AND is_reversal=true AND status='posted'
      LIMIT 1
    `);
    ensure(reversal.rows.length===0, "original journal already reversed");
    const lines=await tx.execute(sql`
      SELECT COUNT(*) AS n,
        COALESCE(SUM(CASE WHEN line_type='debit' THEN amount ELSE 0 END),0) AS debit,
        COALESCE(SUM(CASE WHEN line_type='credit' THEN amount ELSE 0 END),0) AS credit
      FROM sport_center.accounting_journal_lines WHERE journal_id=${journalId}
    `);
    const totals=lines.rows[0] as Record<string,unknown>;
    ensure(num(totals.n)>=2 && num(totals.debit)>0
      && num(totals.debit)===num(totals.credit)
      && num(totals.debit)===num(batch.gross_amount),
      "posted journal lines are not balanced");

    const old=await tx.execute(sql`
      SELECT payment_id FROM sport_center.payment_settlement_items
      WHERE settlement_id=${batchId} AND item_status='active'
    `);
    const oldIds=old.rows.map((r)=>num((r as Record<string,unknown>).payment_id));
    ensure(sameSet(oldIds,original), "original membership differs from approved preflight");

    const payments=await tx.execute(sql`
      SELECT p.id,p.status,p.payment_method,p.payment_provider,p.company_id,
             p.bank_account_id,p.paid_at,p.expected_settlement_date,
             (p.paid_at AT TIME ZONE 'Asia/Jakarta')::date::text AS paid_date,
             p.amount,p.mdr_amount,j.id AS journal_id,j.status AS journal_status
      FROM sport_center.sport_payments p
      JOIN sport_center.accounting_journals j
        ON j.payment_id=p.id AND j.journal_type='payment_confirmed'
       AND j.is_reversal=false
      WHERE p.id IN (${nums(all)})
    `);
    const paymentRows=payments.rows as Array<Record<string,unknown>>;
    const byId=new Map(paymentRows.map((p)=>[num(p.id),p]));
    ensure(paymentRows.length===all.length && byId.size===all.length,
      "posted payment journal missing or ambiguous");
    const memberships=await tx.execute(sql`
      SELECT payment_id,settlement_id FROM sport_center.payment_settlement_items
      WHERE item_status='active' AND payment_id IN (${nums(all)})
    `);
    const ownerById=new Map<number,number[]>();
    for(const r of memberships.rows as Array<Record<string,unknown>>){
      const id=num(r.payment_id),owner=num(r.settlement_id);
      ownerById.set(id,[...(ownerById.get(id)??[]),owner]);
      ensure(owner===batchId,"payment is active in another settlement");
    }
    for(const id of all){
      const owners=ownerById.get(id)??[];
      ensure(owners.length===(original.includes(id)?1:0),
        "source active membership changed");
    }
    const results=[];
    for(const c of cohorts){
      const bankRows=await tx.execute(sql`
        SELECT m.id,m.amount,m.status,m.transaction_date,m.direction,
               m.company_id,m.source_classification,m.journal_entry_id,
               m.approved_at,m.posted_at,
               a.company_id AS bank_company_id,a.account_number,a.is_active
        FROM public.bank_mutations m
        JOIN public.company_bank_accounts a ON a.id::text=m.bank_account_id
        WHERE m.id=${c.mutationId}
      `);
      const bank=bankRows.rows[0] as Record<string,unknown>|undefined;
      ensure(bank && bank.source_classification==="actual_bank_mutation"
        && bank.direction==="IN" && ["unmatched","matched"].includes(String(bank.status))
        && bank.journal_entry_id==null && bank.approved_at==null && bank.posted_at==null
        && bank.is_active===true
        && num(bank.company_id)===num(batch.company_id)
        && num(bank.bank_company_id)===num(batch.company_id)
        && String(bank.account_number)===String(batch.bank_account_id)
        && String(bank.transaction_date).slice(0,10)===c.settlementDate,
        "bank mutation identity, ownership or finality invalid");
      let gross=0,mdr=0;
      const paymentDate=new Date(c.settlementDate+"T00:00:00Z");
      paymentDate.setUTCDate(paymentDate.getUTCDate()-1);
      const paidDay=paymentDate.toISOString().slice(0,10);
      for(const id of c.paymentIds){
        const p=byId.get(id);
        ensure(p && p.status==="confirmed" && p.journal_status==="posted"
          && String(p.payment_method).toLowerCase()==="qris"
          && String(p.payment_provider).toLowerCase()===String(batch.provider_code).toLowerCase()
          && num(p.company_id)===num(batch.company_id)
          && String(p.bank_account_id)===String(batch.bank_account_id)
          && String(p.paid_date).slice(0,10)===paidDay
          && String(p.expected_settlement_date).slice(0,10)===c.settlementDate,
          "payment provider/account/H+1 evidence invalid");
        gross+=num(p.amount);mdr+=num(p.mdr_amount);
      }
      const net=gross-mdr;
      ensure(Math.round(net*100)===Math.round(c.expectedNet*100)
        && Math.round(net*100)===Math.round(num(bank.amount)*100),
        "bank net, gross or MDR do not reconcile");
      results.push({
        bankMutationId:c.mutationId,settlementDate:c.settlementDate,
        paymentIds:c.paymentIds,gross,mdr,net,
        inheritedMembers:c.paymentIds.filter((id)=>original.includes(id)).length,
      });
    }
    ensure(results.filter((r)=>r.settlementDate===String(batch.settlement_date).slice(0,10)
      && r.net===num(batch.net_amount) && r.gross===num(batch.gross_amount)
      && r.mdr===num(batch.mdr_amount)).length===1,
      "no unique replacement for original posted financial totals");
    return {
      ok:true as const,readOnly:true as const,batchId,journalId,
      originalPaymentIds:oldIds,originalJournalDebit:num(totals.debit),
      originalJournalCredit:num(totals.credit),cohorts:results,
      reversalRequired:true as const,postingEnabled:false as const,
    };
  });
}
