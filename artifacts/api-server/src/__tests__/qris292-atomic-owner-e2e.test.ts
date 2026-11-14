import { describe, expect, it } from "vitest";
import pg from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { runAtomicCanonicalSettlementCorrection, rebuildIssue292WithOwnerFunctions } from "../lib/reconciliation/canonicalSettlementCorrectionCoordinator";
import { approveCanonicalSettlementLink } from "../routes/bank-reconciliation";

const url = process.env.QRIS292_ISOLATED_PG_URL;
const dialect = new PgDialect();
const input = {
  settlementId: 5738,
  expectedBankMutationId: 434464,
  replacementPaymentIds: [859,860,861,862],
  actor: "isolated-ci-only",
  reason: "Historical Issue #292 atomic owner E2E, disposable PostgreSQL, always rollback",
};

describe.skipIf(!url)("Issue #292 entire historical reversal + actual owner rebuild + canonical bank approvals", () => {
  it("executes all financial stages inside ONE rollback-only transaction", async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query("BEGIN");
    try {
      // Fixture already has authentic-looking historical #5738 and four wrong members.
      // Supply only the absent payment cohort and immutable posted source receipts.
      await client.query(`
        INSERT INTO sport_center.sport_payments
          (id, company_id, amount, status, settlement_status, payment_method,
           payment_provider, bank_account_id, paid_at, expected_settlement_date,
           settlement_rule_version, mdr_amount)
        VALUES
          (834,1,30000,'confirmed','unsettled','qris','mandiri_direct',
           '1640006707220','2026-11-03 11:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',0),
          (843,1,30000,'confirmed','unsettled','qris','mandiri_direct',
           '1640006707220','2026-11-03 12:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',0),
          (853,1,30000,'confirmed','unsettled','qris','mandiri_direct',
           '1640006707220','2026-11-03 13:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',0),
          (858,1,300000,'confirmed','unsettled','qris','mandiri_direct',
           '1640006707220','2026-11-03 14:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',2100);
        UPDATE sport_center.sport_payments
           SET settlement_status='unsettled'
         WHERE id=862;
        INSERT INTO sport_center.accounting_journals
          (payment_id,company_id,journal_type,status,is_reversal,
           gross_amount,debit_amount,credit_revenue_amount,credit_ppn_amount)
        SELECT p.id,1,'payment_confirmed','posted',false,
               p.amount,p.amount,p.amount,0
        FROM sport_center.sport_payments p
        WHERE p.id IN (834,843,853,856,858,859,860,861,862);
        INSERT INTO public.bank_mutations
          (id,status,company_id,amount,transaction_date,source_classification,
           direction,bank_account_id,reconciliation_status)
        VALUES (434462,'unmatched',1,685800,'2026-11-04',
                'actual_bank_mutation','IN','17','unmatched');
      `);
      const tx = {
        execute: async (statement: any) => {
          const q=dialect.sqlToQuery(statement);
          return client.query(q.sql,q.params);
        },
      };
      const db = {transaction: async (callback: any) => callback(tx)} as any;
      const result=await runAtomicCanonicalSettlementCorrection(db,input,{
        rebuildBothDatedBatches: (t,reversal) =>
          rebuildIssue292WithOwnerFunctions(t,reversal,"isolated-ci-only"),
        approveBothCanonicalBankMatches: async (_t,batches) => {
          for (const [mutation,batch] of [
            [434462,batches.nov4BatchId],
            [434464,batches.nov5BatchId],
          ] as const) {
            const approved=await approveCanonicalSettlementLink(
              client,mutation,batch,null,
              {email:"isolated-ci-only",companyId:1},
              `issue292-atomic:${mutation}`,
            );
            expect(approved).toMatchObject({ok:true,status:"approved",journal_entry_id:null});
            const retry=await approveCanonicalSettlementLink(
              client,mutation,batch,null,
              {email:"isolated-ci-only",companyId:1},
              `issue292-atomic:${mutation}`,
            );
            expect(retry).toMatchObject({ok:true,status:"approved",idempotent:true});
          }
          return {approved:[434462,434464]};
        },
      });
      expect(result.reversal.ok).toBe(true);
      expect(result.batches.nov4BatchId).not.toBe(5738);
      expect(result.batches.nov5BatchId).not.toBe(5738);
      const check=await client.query(`
        SELECT
          (SELECT count(*)::int FROM sport_center.accounting_journals
             WHERE reversal_of_id=7207 AND status='posted') AS reversals,
          (SELECT count(*)::int FROM sport_center.payment_settlement_items
             WHERE settlement_id=5738 AND item_status='reversed') AS old_members,
          (SELECT count(*)::int FROM public.bank_reconciliation_matches
             WHERE mutation_id IN (434462,434464) AND status='approved') AS approved_matches,
          (SELECT COALESCE(sum(amount),0)::numeric FROM public.bank_mutations
             WHERE id IN (434462,434464) AND status='approved') AS net
      `);
      expect(Number(check.rows[0].reversals)).toBe(1);
      expect(Number(check.rows[0].old_members)).toBe(4);
      expect(Number(check.rows[0].approved_matches)).toBe(2);
      expect(Number(check.rows[0].net)).toBe(1609500);
      // Verify manual ledger trace: original journal stays posted and unchanged;
      // one compensating journal must swap debit and credit on identical COAs.
      const journalTrace = await client.query(`
        SELECT j.id,j.reversal_of_id,j.status,l.account_code,l.line_type,
               l.amount::numeric AS amount
        FROM sport_center.accounting_journals j
        JOIN sport_center.accounting_journal_lines l ON l.journal_id=j.id
        WHERE j.id=7207 OR j.reversal_of_id=7207
        ORDER BY j.id,l.account_code
      `);
      const originalLines=journalTrace.rows.filter(r=>Number(r.id)===7207)
        .map(r=>[r.account_code,r.line_type,Number(r.amount)]);
      const compensationLines=journalTrace.rows.filter(r=>Number(r.reversal_of_id)===7207)
        .map(r=>[r.account_code,r.line_type,Number(r.amount)]);
      expect(originalLines).toEqual([
        ["1-1023-CST","debit",923700],
        ["1-1024-CST","credit",930000],
        ["5-3050-CST","debit",6300],
      ]);
      expect(compensationLines).toEqual([
        ["1-1023-CST","credit",923700],
        ["1-1024-CST","debit",930000],
        ["5-3050-CST","credit",6300],
      ]);
      expect(journalTrace.rows.every(r=>r.status==="posted")).toBe(true);

      // No generic bank journal and exactly one approved candidate per bank.
      const approvals=await client.query(`
        SELECT m.id,m.status,m.journal_entry_id,
          (SELECT count(*)::int FROM public.bank_reconciliation_matches x
            WHERE x.mutation_id=m.id AND x.status='approved') AS approved_count
        FROM public.bank_mutations m WHERE id IN (434462,434464) ORDER BY id
      `);
      expect(approvals.rows.map(r=>[Number(r.id),r.status,r.journal_entry_id,Number(r.approved_count)]))
        .toEqual([[434462,"approved",null,1],[434464,"approved",null,1]]);

      // Preserve original payment dates and each posted confirmed receipt journal.
      const sourceIntegrity=await client.query(`
        SELECT p.id,
          ((p.paid_at AT TIME ZONE 'Asia/Jakarta')::date+1)::text AS h_plus_one,
          p.status, p.settlement_status,
          (SELECT count(*)::int FROM sport_center.accounting_journals j
             WHERE j.payment_id=p.id AND j.journal_type='payment_confirmed'
               AND j.status='posted' AND j.is_reversal=false) AS receipts
        FROM sport_center.sport_payments p
        WHERE p.id IN (834,843,853,856,858,859,860,861,862)
        ORDER BY p.id
      `);
      expect(sourceIntegrity.rows).toHaveLength(9);
      expect(sourceIntegrity.rows.map(r=>Number(r.id))).toEqual(
        [834,843,853,856,858,859,860,861,862],
      );
      for(const row of sourceIntegrity.rows){
        expect(row.h_plus_one).toBe(Number(row.id)<=858?"2026-11-04":"2026-11-05");
        expect(row.status).toBe("confirmed");
        expect(row.settlement_status).toBe("settled");
        expect(Number(row.receipts)).toBe(1);
      }
      const history=await client.query(`
        SELECT status FROM public.bank_reconciliation_matches WHERE id=14449
      `);
      expect(history.rows[0]?.status).toBe("superseded");
      const audit=await client.query(`
        SELECT count(*)::int AS n FROM public.bank_reconciliation_audit
        WHERE action='CANONICAL_SETTLEMENT_MEMBERSHIP_CORRECTION_REVERSED'
          AND mutation_id=434464
      `);
      expect(audit.rows[0].n).toBe(1);
    } finally {
      await client.query("ROLLBACK").catch(()=>undefined);
      await client.end();
    }
    const independent=new pg.Client({connectionString:url});
    await independent.connect();
    try {
      const r=await independent.query(`
        SELECT (SELECT status FROM sport_center.payment_settlement_batches
                  WHERE id=5738) AS original,
               (SELECT count(*)::int FROM sport_center.accounting_journals
                  WHERE reversal_of_id=7207) AS reversals,
               (SELECT count(*)::int FROM sport_center.payment_settlement_batches
                  WHERE id<>5738) AS replacements,
               (SELECT count(*)::int FROM public.bank_reconciliation_matches
                  WHERE status='approved' AND mutation_id IN (434462,434464)) AS approvals,
               (SELECT count(*)::int FROM sport_center.sport_payments
                  WHERE id IN (834,843,853,858)) AS inserted_payments
      `);
      expect(r.rows[0]).toEqual({
        original:"posted",reversals:0,replacements:0,
        approvals:0,inserted_payments:0,
      });
    } finally {await independent.end();}
  });
});
