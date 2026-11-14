import {describe,it,expect} from "vitest";
import pg from "pg";
import { approveCanonicalSettlementLink } from "../routes/bank-reconciliation";

const isolated=process.env.QRIS292_ISOLATED_PG_URL;
describe.skipIf(!isolated)("Issue #292 actual owner batch writer positive transaction",()=>{
  it("creates owner-calculated Nov 4 normal and Nov 5 supplemental batches then rolls back",async()=>{
    const client=new pg.Client({connectionString:isolated});
    await client.connect();
    await client.query("BEGIN");
    try {
      // Synthetic valid source payment with no active settlement item.
      await client.query(`
        INSERT INTO sport_center.sport_payments
        (id,company_id,amount,status,settlement_status,payment_method,
         payment_provider,bank_account_id,paid_at,expected_settlement_date,
         settlement_rule_version,mdr_amount)
        VALUES(834,1,30000,'confirmed','unsettled','qris','mandiri_direct',
          '1640006707220','2026-11-03T11:00:00+07','2026-11-04',
          'PROD-MANDIRI-SC-20260831-v1',0);
        INSERT INTO sport_center.accounting_journals
          (payment_id,company_id,journal_type,status,is_reversal,
           gross_amount,debit_amount,credit_revenue_amount,credit_ppn_amount)
        VALUES(834,1,'payment_confirmed','posted',false,30000,30000,30000,0),
              (862,1,'payment_confirmed','posted',false,300000,300000,300000,0);
      `);
      const id=await client.query<{settlement_reference:string}>(`
        SELECT settlement_reference FROM sport_center.canonical_settlement_group_identity(
          1,'mandiri_direct','1640006707220','2026-11-04'::date,
          'PROD-MANDIRI-SC-20260831-v1')
      `);
      const nov4=await client.query<{id:string}>(`
        SELECT sport_center.create_payment_settlement_batch(
          $1,1,'mandiri_direct','1640006707220','2026-11-04'::date,
          ARRAY[834]::integer[],'isolated-ci-only') AS id
      `,[id.rows[0].settlement_reference]);
      const nov5=await client.query<{id:string}>(`
        SELECT sport_center.create_payment_settlement_supplemental_batch(
          1,'mandiri_direct','1640006707220','2026-11-05'::date,
          'PROD-MANDIRI-SC-20260831-v1',
          ARRAY[862]::integer[],'isolated-ci-only') AS id
      `);
      expect(Number(nov4.rows[0].id)).toBeGreaterThan(5738);
      expect(Number(nov5.rows[0].id)).toBeGreaterThan(5738);
      expect(nov4.rows[0].id).not.toBe(nov5.rows[0].id);
      // Repeated requests must reuse the exact owner-created batches.
      // This checks genuine owner SQL idempotency rather than synthetic IDs.
      const nov4Retry=await client.query<{id:string}>(`
        SELECT sport_center.create_payment_settlement_batch(
          $1,1,'mandiri_direct','1640006707220','2026-11-04'::date,
          ARRAY[834]::integer[],'isolated-ci-only') AS id
      `,[id.rows[0].settlement_reference]);
      const nov5Retry=await client.query<{id:string}>(`
        SELECT sport_center.create_payment_settlement_supplemental_batch(
          1,'mandiri_direct','1640006707220','2026-11-05'::date,
          'PROD-MANDIRI-SC-20260831-v1',
          ARRAY[862]::integer[],'isolated-ci-only') AS id
      `);
      expect(nov4Retry.rows[0].id).toBe(nov4.rows[0].id);
      expect(nov5Retry.rows[0].id).toBe(nov5.rows[0].id);
      const created=await client.query(`
        SELECT count(*)::int AS n FROM sport_center.payment_settlement_batches
        WHERE id<>5738
      `);
      expect(created.rows[0].n).toBe(2);
      const rows=await client.query<{
        settlement_date:string;gross_amount:string;mdr_amount:string;net_amount:string;
        status:string;payment_ids:number[];
      }>(`
        SELECT b.settlement_date::text,b.gross_amount::text,b.mdr_amount::text,
          b.net_amount::text,b.status,
          ARRAY(SELECT i.payment_id FROM sport_center.payment_settlement_items i
                WHERE i.settlement_id=b.id AND i.item_status='active'
                ORDER BY i.payment_id) AS payment_ids
        FROM sport_center.payment_settlement_batches b
        WHERE b.id=ANY($1::bigint[]) ORDER BY b.settlement_date
      `,[[nov4.rows[0].id,nov5.rows[0].id]]);
      expect(rows.rows.map(x=>({
        date:x.settlement_date,gross:Number(x.gross_amount),
        mdr:Number(x.mdr_amount),net:Number(x.net_amount),
        status:x.status,ids:x.payment_ids,
      }))).toEqual([
        {date:"2026-11-04",gross:30000,mdr:0,net:30000,status:"calculated",ids:[834]},
        {date:"2026-11-05",gross:300000,mdr:2100,net:297900,status:"calculated",ids:[862]},
      ]);
    }finally{
      await client.query("ROLLBACK").catch(()=>undefined);
      await client.end();
    }
    const check=new pg.Client({connectionString:isolated});
    await check.connect();
    try{
      const r=await check.query(`
        SELECT (SELECT count(*)::int FROM sport_center.payment_settlement_batches
                WHERE id<>5738) AS extra_batches,
               (SELECT count(*)::int FROM sport_center.accounting_journals
                WHERE payment_id IN (834,862)) AS source_journals
      `);
      expect(r.rows[0]).toEqual({extra_batches:0,source_journals:0});
    }finally{await check.end();}
  });
  it("builds full 5+4 synthetic QRIS cohorts with real owner functions, then leaves no committed rows",async()=>{
    const client=new pg.Client({connectionString:isolated});
    await client.connect();
    const nov4Ids=[9834,9843,9853,9856,9858];
    const nov5Ids=[9859,9860,9861,9862];
    const all=[...nov4Ids,...nov5Ids];
    await client.query("BEGIN");
    try {
      // The historical SOURCE composition, but independent synthetic IDs.
      // Original historical #5738 and its member rows are not modified.
      await client.query(`
        INSERT INTO sport_center.sport_payments
          (id,company_id,amount,status,settlement_status,payment_method,
           payment_provider,bank_account_id,paid_at,expected_settlement_date,
           settlement_rule_version,mdr_amount)
        SELECT source_id,1,CASE WHEN source_id IN (9834,9843,9853,9861)
                                   THEN 30000 ELSE 300000 END,
           'confirmed','unsettled','qris','mandiri_direct','1640006707220',
           CASE WHEN source_id=ANY($1::integer[])
             THEN '2026-11-03 12:00:00+07'::timestamptz
             ELSE '2026-11-04 12:00:00+07'::timestamptz END,
           CASE WHEN source_id=ANY($1::integer[])
             THEN '2026-11-04' ELSE '2026-11-05' END,
           'PROD-MANDIRI-SC-20260831-v1',
           CASE WHEN source_id IN (9834,9843,9853,9861)
             THEN 0 ELSE 2100 END
        FROM unnest($2::integer[]) AS source(source_id)
      `,[nov4Ids,all]);
      await client.query(`
        INSERT INTO sport_center.accounting_journals
          (payment_id,company_id,journal_type,status,is_reversal,
           gross_amount,debit_amount,credit_revenue_amount,credit_ppn_amount)
        SELECT p.id,1,'payment_confirmed','posted',false,
          p.amount,p.amount,p.amount,0
        FROM sport_center.sport_payments p WHERE p.id=ANY($1::integer[])
      `,[all]);
      const reference=await client.query<{settlement_reference:string}>(`
        SELECT settlement_reference FROM sport_center.canonical_settlement_group_identity(
          1,'mandiri_direct','1640006707220','2026-11-04'::date,
          'PROD-MANDIRI-SC-20260831-v1')
      `);
      const day4=await client.query<{id:string}>(`
        SELECT sport_center.create_payment_settlement_batch(
          $1,1,'mandiri_direct','1640006707220','2026-11-04'::date,
          $2::integer[],'isolated-ci-only') AS id
      `,[reference.rows[0].settlement_reference,nov4Ids]);
      const day5=await client.query<{id:string}>(`
        SELECT sport_center.create_payment_settlement_supplemental_batch(
          1,'mandiri_direct','1640006707220','2026-11-05'::date,
          'PROD-MANDIRI-SC-20260831-v1',
          $1::integer[],'isolated-ci-only') AS id
      `,[nov5Ids]);
      expect(day4.rows[0].id).not.toBe(day5.rows[0].id);
      const r=await client.query<{
        settlement_date:string;gross_amount:string;mdr_amount:string;
        net_amount:string;status:string;payment_ids:number[];
      }>(`
        SELECT b.settlement_date::text,b.gross_amount::text,
          b.mdr_amount::text,b.net_amount::text,b.status,
          ARRAY(SELECT i.payment_id FROM sport_center.payment_settlement_items i
            WHERE i.settlement_id=b.id AND i.item_status='active'
            ORDER BY i.payment_id) AS payment_ids
        FROM sport_center.payment_settlement_batches b
        WHERE b.id=ANY($1::bigint[]) ORDER BY b.settlement_date
      `,[[day4.rows[0].id,day5.rows[0].id]]);
      expect(r.rows.map(x=>({
        date:x.settlement_date,gross:Number(x.gross_amount),
        mdr:Number(x.mdr_amount),net:Number(x.net_amount),
        status:x.status,ids:x.payment_ids,
      }))).toEqual([
        {date:"2026-11-04",gross:690000,mdr:4200,net:685800,
          status:"calculated",ids:nov4Ids},
        {date:"2026-11-05",gross:930000,mdr:6300,net:923700,
          status:"calculated",ids:nov5Ids},
      ]);
      // Real owner journal drafts, not manually inserted fake journal lines.
      const journals=[];
      for(const batchId of [day4.rows[0].id,day5.rows[0].id]){
        const draft=await client.query<{id:number}>(`
          SELECT sport_center.create_settlement_journal_draft(
            $1::bigint,'1-1023-CST','isolated-ci-only') AS id
        `,[batchId]);
        journals.push(Number(draft.rows[0].id));
      }
      const lines=await client.query<{
        journal_id:number; account_code:string;line_type:string;amount:string;
      }>(`
        SELECT journal_id,account_code,line_type,amount::text AS amount
        FROM sport_center.accounting_journal_lines
        WHERE journal_id=ANY($1::integer[])
        ORDER BY journal_id,account_code
      `,[journals]);
      const byJournal=(id:number)=>lines.rows.filter(x=>x.journal_id===id)
        .map(x=>[x.account_code,x.line_type,Number(x.amount)]);
      expect(byJournal(journals[0])).toEqual([
        ["1-1023-CST","debit",685800],
        ["1-1024-CST","credit",690000],
        ["5-3050-CST","debit",4200],
      ]);
      expect(byJournal(journals[1])).toEqual([
        ["1-1023-CST","debit",923700],
        ["1-1024-CST","credit",930000],
        ["5-3050-CST","debit",6300],
      ]);
      // Finalize with the UNMODIFIED owner functions: approval, journal
      // posting, settlement status and payment metadata in the same tx.
      // No COMMIT is permitted in this CI test.
      for (const batchId of [day4.rows[0].id,day5.rows[0].id]) {
        const finished=await client.query<{id:string}>(`
          SELECT sport_center.finalize_payment_settlement(
            $1::bigint,'isolated-ci-only') AS id
        `,[batchId]);
        expect(Number(finished.rows[0].id)).toBe(Number(batchId));
      }
      const status=await client.query<{
        settlement_id:string;batch_status:string;journal_status:string;
        payment_ids:number[];settled_count:number;
      }>(`
        SELECT b.id::text AS settlement_id,b.status AS batch_status,
          j.status AS journal_status,
          ARRAY(SELECT i.payment_id FROM sport_center.payment_settlement_items i
            WHERE i.settlement_id=b.id AND i.item_status='active'
            ORDER BY i.payment_id) AS payment_ids,
          (SELECT count(*)::int
             FROM sport_center.sport_payments p
             JOIN sport_center.payment_settlement_items i ON i.payment_id=p.id
            WHERE i.settlement_id=b.id AND i.item_status='active'
              AND p.settlement_status='settled') AS settled_count
        FROM sport_center.payment_settlement_batches b
        JOIN sport_center.accounting_journals j ON j.id=b.settlement_journal_id
        WHERE b.id=ANY($1::bigint[])
        ORDER BY b.settlement_date
      `,[[day4.rows[0].id,day5.rows[0].id]]);
      expect(status.rows.map(x=>({
        batch:x.batch_status,journal:x.journal_status,
        members:x.payment_ids,settled:x.settled_count,
      }))).toEqual([
        {batch:"posted",journal:"posted",members:nov4Ids,settled:5},
        {batch:"posted",journal:"posted",members:nov5Ids,settled:4},
      ]);
      // Connect both real canonical bank mutations with the existing
      // application approval function. Never create generic bank journals.
      // All writes are in the SAME connection/transaction as the owner batches.
      await client.query(`
        INSERT INTO public.bank_mutations
          (id,status,company_id,amount,transaction_date,source_classification,
           direction,bank_account_id,reconciliation_status)
        VALUES(434462,'unmatched',1,685800,'2026-11-04',
               'actual_bank_mutation','IN','17','unmatched')
      `);
      await client.query(`
        UPDATE public.bank_mutations
           SET status='unmatched',reconciliation_status='unmatched'
         WHERE id=434464 AND status='matched'
      `);
      const approvalActor={email:"isolated-ci-only",companyId:1};
      for(const [bankId,batchId] of [[434462,day4.rows[0].id],[434464,day5.rows[0].id]] as const){
        const approved=await approveCanonicalSettlementLink(
          client,bankId,Number(batchId),null,approvalActor,`issue292-test:${bankId}`,
        );
        expect(approved).toMatchObject({ok:true,status:"approved",journal_entry_id:null});
        const retry=await approveCanonicalSettlementLink(
          client,bankId,Number(batchId),null,approvalActor,`issue292-test:${bankId}`,
        );
        expect(retry).toMatchObject({ok:true,status:"approved",idempotent:true});
      }
      const linked=await client.query(`
        SELECT b.settlement_date::text AS day,b.status AS batch_status,
               m.status AS bank_status,m.journal_entry_id,
               (SELECT count(*)::int FROM public.bank_reconciliation_matches x
                 WHERE x.mutation_id=m.id AND x.status='approved') AS approved_matches
        FROM sport_center.payment_settlement_batches b
        JOIN public.bank_mutations m ON m.id=b.bank_mutation_id
        WHERE b.id=ANY($1::bigint[]) ORDER BY b.settlement_date
      `,[[day4.rows[0].id,day5.rows[0].id]]);
      expect(linked.rows).toEqual([
        {day:"2026-11-04",batch_status:"reconciled",bank_status:"approved",
         journal_entry_id:null,approved_matches:1},
        {day:"2026-11-05",batch_status:"reconciled",bank_status:"approved",
         journal_entry_id:null,approved_matches:1},
      ]);
    }finally{
      await client.query("ROLLBACK").catch(()=>undefined);
      await client.end();
    }
    const verify=new pg.Client({connectionString:isolated});
    await verify.connect();
    try {
      const r=await verify.query(`
        SELECT
          (SELECT count(*)::int FROM sport_center.sport_payments
           WHERE id=ANY($1::integer[])) AS synthetic_payments,
          (SELECT count(*)::int FROM sport_center.accounting_journals
           WHERE payment_id=ANY($1::integer[])) AS synthetic_receipts,
          (SELECT count(*)::int FROM sport_center.payment_settlement_batches
           WHERE id<>5738) AS extra_batches,
          (SELECT count(*)::int FROM sport_center.accounting_journals
           WHERE journal_type='settlement' AND settlement_batch_id<>5738)
           AS extra_settlement_journals,
          (SELECT count(*)::int FROM public.bank_reconciliation_matches
           WHERE mutation_id IN (434462,434464) AND status='approved') AS approved_matches,
          (SELECT count(*)::int FROM public.bank_reconciliation_audit
           WHERE action='CANONICAL_SETTLEMENT_LINK_APPROVED') AS approval_audits,
          (SELECT status FROM public.bank_mutations WHERE id=434464) AS original_bank_status,
          (SELECT count(*)::int FROM public.bank_mutations WHERE id=434462) AS new_bank_rows,
          (SELECT status FROM sport_center.payment_settlement_batches
           WHERE id=5738) AS original_status
      `,[all]);
      expect(r.rows[0]).toEqual({
        synthetic_payments:0,synthetic_receipts:0,extra_batches:0,
        extra_settlement_journals:0,approved_matches:0,approval_audits:0,
        original_bank_status:"matched",new_bank_rows:0,original_status:"posted",
      });
    } finally { await verify.end(); }
  });

});
