/** Read-only runtime preflight for a posted/unlinked canonical QRIS batch.
 * No reversal, auto-approval, posting, or database writes are performed here.
 */
export interface ReconciliationReadClient {
  query: (text: string, values?: any[]) => Promise<{rows: Record<string, any>[]}>;
}
export type BankCohortEvidence = {
  mutationId: number; settlementDate: string; paymentIds: number[];
  gross: number; mdr: number; net: number;
};
export type PostedBatchPreflightResult = {
  ok: true; readOnly: true; postingPermitted: false;
  batchId: number; sourceJournalId: number;
  originalPaymentIds: number[];
  cohorts: BankCohortEvidence[];
};

const money = (value: unknown) => Number(value);
const strDate = (value: unknown) => String(value ?? "").slice(0,10);
function requireEvidence(value: unknown, message: string): asserts value {
  if (!value) throw new Error("QRIS_POSTED_PREFLIGHT: " + message);
}
const sameSet = (x: number[],y: number[]) =>
  JSON.stringify([...x].sort((a,b)=>a-b))===JSON.stringify([...y].sort((a,b)=>a-b));

export async function inspectPostedUnlinkedBankCohorts(
  client: ReconciliationReadClient,
  batchId: number,
  mutationIds: number[],
  actorCompanyId: number | null,
): Promise<PostedBatchPreflightResult> {
  requireEvidence(Number.isSafeInteger(batchId) && batchId>0, "invalid settlement ID");
  requireEvidence(mutationIds.length===2 &&
    new Set(mutationIds).size===2 &&
    mutationIds.every(id=>Number.isSafeInteger(id)&&id>0), "two bank IDs required");
  const batchRows=await client.query([
    "select b.id,b.status,b.company_id,b.provider_code,b.bank_account_id,",
    "b.settlement_date::text,b.gross_amount,b.mdr_amount,b.net_amount,",
    "b.settlement_journal_id,b.bank_mutation_id,b.canonical_bank_mutation_id,",
    "j.status as journal_status,j.journal_type,j.is_reversal,",
    "j.settlement_batch_id as journal_batch_id",
    "from sport_center.payment_settlement_batches b",
    "join sport_center.accounting_journals j on j.id=b.settlement_journal_id",
    "where b.id=$1"
  ].join(" "),[batchId]);
  const b=batchRows.rows[0];
  requireEvidence(b && b.status==="posted" &&
    b.bank_mutation_id==null && b.canonical_bank_mutation_id==null &&
    b.journal_status==="posted" && b.journal_type==="settlement" &&
    b.is_reversal===false && Number(b.journal_batch_id)===batchId,
    "batch not posted/unlinked with valid posted original journal");
  requireEvidence(actorCompanyId==null || Number(b.company_id)===actorCompanyId,
    "company access mismatch");
  const j=await client.query([
    "select count(*)::int as n,",
    "coalesce(sum(amount) filter (where line_type='debit'),0) as debits,",
    "coalesce(sum(amount) filter (where line_type='credit'),0) as credits",
    "from sport_center.accounting_journal_lines where journal_id=$1"
  ].join(" "),[b.settlement_journal_id]);
  const jl=j.rows[0];
  requireEvidence(jl && Number(jl.n)>=2 && money(jl.debits)>0 &&
    money(jl.debits)===money(jl.credits) &&
    money(jl.debits)===money(b.gross_amount),"original journal unbalanced");
  const rv=await client.query(
    "select id from sport_center.accounting_journals where reversal_of_id=$1 and is_reversal=true and status='posted' limit 1",
    [b.settlement_journal_id]);
  requireEvidence(rv.rows.length===0,"original has a posted reversal");
  const items=await client.query(
    "select payment_id from sport_center.payment_settlement_items where settlement_id=$1 and item_status='active' order by payment_id",
    [batchId]);
  const originals=items.rows.map(x=>Number(x.payment_id));
  requireEvidence(originals.length>0 && new Set(originals).size===originals.length,
    "original active item set invalid");
  const bankRows=await client.query([
    "select m.id,m.company_id,m.status,m.transaction_date::text,m.amount,",
    "m.source_classification,m.direction,m.journal_entry_id,m.approved_at,m.posted_at,",
    "a.company_id as account_company_id,a.account_number,a.is_active",
    "from public.bank_mutations m",
    "join public.company_bank_accounts a on a.id::text=m.bank_account_id",
    "where m.id=any($1::int[])"
  ].join(" "),[mutationIds]);
  requireEvidence(bankRows.rows.length===2,"bank statement row missing");
  const cohorts:BankCohortEvidence[]=[];
  for(const bank of bankRows.rows){
    requireEvidence(bank.source_classification==="actual_bank_mutation" &&
      bank.direction==="IN" && ["unmatched","matched"].includes(String(bank.status)) &&
      bank.journal_entry_id==null && bank.approved_at==null && bank.posted_at==null &&
      bank.is_active===true && Number(bank.company_id)===Number(b.company_id) &&
      Number(bank.account_company_id)===Number(b.company_id) &&
      String(bank.account_number)===String(b.bank_account_id),
      "bank identity, owner, or posting evidence invalid");
    const settlementDate=strDate(bank.transaction_date);
    const p=await client.query([
      "select p.id,p.amount,p.mdr_amount,",
      "(select count(*) from sport_center.accounting_journals j",
      "where j.payment_id=p.id and j.journal_type='payment_confirmed'",
      "and j.is_reversal=false and j.status='posted')::int as journal_count",
      "from sport_center.sport_payments p",
      "where p.status='confirmed' and lower(p.payment_method)='qris'",
      "and lower(p.payment_provider::text)=lower($1)",
      "and p.company_id=$2 and p.bank_account_id=$3",
      "and (p.paid_at at time zone 'Asia/Jakarta')::date=($4::date - 1)",
      "and p.expected_settlement_date::date=$4::date",
      "order by p.id"
    ].join(" "),[b.provider_code,b.company_id,b.bank_account_id,settlementDate]);
    const paymentIds=p.rows.map(x=>Number(x.id));
    requireEvidence(paymentIds.length>0 &&
      p.rows.every(x=>Number(x.journal_count)===1),
      "confirmed payment source is missing a unique posted journal");
    const gross=p.rows.reduce((sum,x)=>sum+money(x.amount),0);
    const mdr=p.rows.reduce((sum,x)=>sum+money(x.mdr_amount),0);
    const net=Number((gross-mdr).toFixed(2));
    requireEvidence(net===money(bank.amount),"bank net does not match QRIS source net");
    cohorts.push({mutationId:Number(bank.id),settlementDate,paymentIds,gross,mdr,net});
  }
  const all=cohorts.flatMap(c=>c.paymentIds);
  requireEvidence(all.length===new Set(all).size &&
    originals.every(id=>all.includes(id)),"replacement cohorts omit or duplicate payments");
  const owners=await client.query([
    "select payment_id,settlement_id from sport_center.payment_settlement_items",
    "where item_status='active' and payment_id=any($1::int[])"
  ].join(" "),[all]);
  requireEvidence(owners.rows.every(x=>Number(x.settlement_id)===batchId) &&
    sameSet(owners.rows.map(x=>Number(x.payment_id)),originals),
    "active settlement membership belongs to another batch");
  const sameMoney=cohorts.filter(x=>x.settlementDate===strDate(b.settlement_date) &&
    x.gross===money(b.gross_amount) && x.mdr===money(b.mdr_amount) &&
    x.net===money(b.net_amount));
  requireEvidence(sameMoney.length===1,
    "original batch financial totals do not match a unique bank cohort");
  return {ok:true,readOnly:true,postingPermitted:false,batchId,
    sourceJournalId:Number(b.settlement_journal_id),
    originalPaymentIds:originals,
    cohorts:cohorts.sort((a,b)=>a.settlementDate.localeCompare(b.settlementDate))};
}
