import {describe,it,expect} from "vitest";
import pg from "pg";

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
});
