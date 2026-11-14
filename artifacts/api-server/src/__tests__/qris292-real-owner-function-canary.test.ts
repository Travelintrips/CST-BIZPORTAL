import { describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Genuine CST-DEV function-body canary in isolated PostgreSQL 16.
 * This deliberately tests only the first rejection path. It is NOT a
 * successful batch creation, journal posting, or dual-bank E2E proof.
 */
const isolated = process.env.QRIS292_ISOLATED_PG_URL;
describe.skipIf(!isolated)("Issue #292 genuine owner SQL canary, read-only", () => {
  it("rejects real populated payment groups on the wrong H+1 day before any batch is created", async () => {
    const client=new pg.Client({connectionString:isolated});
    await client.connect();
    await client.query("BEGIN READ ONLY");
    try {
      const wrongDayCalls=[
        `SELECT sport_center.create_payment_settlement_batch(
          'ISSUE292-WRONG-DATE',1,'mandiri_direct','1640006707220',
          '2026-11-05'::date,ARRAY[856]::integer[],'issue292-ci-readonly')`,
        `SELECT sport_center.create_payment_settlement_supplemental_batch(
          1,'mandiri_direct','1640006707220',
          '2026-11-04'::date,'PROD-MANDIRI-SC-20260831-v1',
          ARRAY[859]::integer[],'issue292-ci-readonly')`,
      ];
      for(const sql of wrongDayCalls){
        await client.query("SAVEPOINT wrong_day");
        await expect(client.query(sql)).rejects.toMatchObject({
          code:"P0001",
          message:expect.stringContaining("CANONICAL_SETTLEMENT_GROUP_INVALID"),
        });
        await client.query("ROLLBACK TO SAVEPOINT wrong_day");
      }
      const check=await client.query(`
        SELECT count(*)::int AS replacements
          FROM sport_center.payment_settlement_batches WHERE id<>5738
      `);
      expect(check.rows[0].replacements).toBe(0);
    } finally {
      await client.query("ROLLBACK").catch(()=>undefined);
      await client.end();
    }
  });

  it("runs both genuine owner functions and rejects empty payment IDs without writes", async () => {
    const client = new pg.Client({ connectionString: isolated });
    await client.connect();
    try {
      await client.query("BEGIN READ ONLY");
      const mode=await client.query("SELECT current_setting('transaction_read_only') AS mode");
      expect(mode.rows[0].mode).toBe("on");
      const identity = await client.query<{
        normal: boolean; supplemental: boolean;
      }>(`
        SELECT
          EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='sport_center' AND p.proname='create_payment_settlement_batch'
             AND p.prosecdef=true
             AND length(pg_get_functiondef(p.oid))>4000
             AND position('CANONICAL_SETTLEMENT_GROUP_INVALID'
                          in pg_get_functiondef(p.oid))>0) AS normal,
          EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='sport_center'
             AND p.proname='create_payment_settlement_supplemental_batch'
             AND p.prosecdef=true
             AND length(pg_get_functiondef(p.oid))>12000
             AND position('QRIS_MDR_SOURCE_REQUIRES_REVIEW'
                          in pg_get_functiondef(p.oid))>0) AS supplemental
      `);
      expect(identity.rows[0]).toEqual({ normal: true, supplemental: true });
      const queries = [
        `SELECT sport_center.create_payment_settlement_batch(
           'ISSUE292-CANARY',1,'mandiri_direct','1640006707220',
           '2026-11-04'::date,ARRAY[]::integer[],'issue292-ci-readonly')`,
        `SELECT sport_center.create_payment_settlement_supplemental_batch(
           1,'mandiri_direct','1640006707220','2026-11-05'::date,
           'PROD-MANDIRI-SC-20260831-v1',ARRAY[]::integer[],'issue292-ci-readonly')`,
      ];
      for (const query of queries) {
        await client.query("SAVEPOINT owner_canary");
        await expect(client.query(query)).rejects.toMatchObject({
          code: "P0001",
          message: expect.stringContaining("PAYMENT_IDS_REQUIRED"),
        });
        await client.query("ROLLBACK TO SAVEPOINT owner_canary");
      }
      const state = await client.query<{
        status:string; extra_batches:string; reversal_journals:string;
      }>(`
        SELECT b.status,
          (SELECT count(*)::text FROM sport_center.payment_settlement_batches
           WHERE id<>5738) AS extra_batches,
          (SELECT count(*)::text FROM sport_center.accounting_journals
           WHERE reversal_of_id=7207) AS reversal_journals
        FROM sport_center.payment_settlement_batches b WHERE b.id=5738
      `);
      expect(state.rows[0]).toEqual({
        status: "posted", extra_batches: "0", reversal_journals: "0",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  });
});
