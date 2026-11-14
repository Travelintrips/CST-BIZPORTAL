import { describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Installed real SQL owner stack canary. Read-only; does not execute a
 * successful financial write or imply that full E2E has passed.
 */
const isolated = process.env.QRIS292_ISOLATED_PG_URL;
describe.skipIf(!isolated)("Issue #292 exact owner settlement SQL support stack", () => {
  it("installs all 11 real functions and executes real MDR arithmetic read-only", async () => {
    const client = new pg.Client({ connectionString: isolated });
    await client.connect();
    try {
      await client.query("BEGIN READ ONLY");
      const functions = await client.query<{proname:string}>(`
        SELECT p.proname FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='sport_center'
          AND p.proname = ANY($1::text[])
        ORDER BY p.proname
      `, [[
        "calculate_settlement_mdr","canonical_settlement_group_identity",
        "create_payment_settlement_batch","create_payment_settlement_batch_legacy",
        "create_payment_settlement_supplemental_batch",
        "create_settlement_journal_draft","finalize_payment_settlement",
        "finalize_payment_settlement_legacy","mark_settlement_payments_settled",
        "resolve_payment_settlement_config","validate_accounting_journal",
      ]]);
      expect(functions.rows.map(x=>x.proname)).toHaveLength(11);
      const raw = await client.query<{
        gross_amount:string; base_mdr_amount:string;
        total_deduction:string; net_amount:string;
      }>(`
        SELECT gross_amount::text,base_mdr_amount::text,
               total_deduction::text,net_amount::text
        FROM sport_center.calculate_settlement_mdr(
          930000::numeric,0.007::numeric,0::numeric,0::numeric,
          false,2,'round_half_up')
      `);
      expect(Number(raw.rows[0]?.gross_amount)).toBe(930000);
      expect(Number(raw.rows[0]?.base_mdr_amount)).toBe(6510);
      expect(Number(raw.rows[0]?.total_deduction)).toBe(6510);
      expect(Number(raw.rows[0]?.net_amount)).toBe(923490);
      // The genuine owner builder overrides aggregate MDR using confirmed
      // per-payment MDR (6300) for this historical QRIS cohort.
      // Do NOT mistake generic 6510 for bank-verified 6300.
      const source = await client.query<{
        mdr:string; gross:string;
      }>(`
        SELECT sum(mdr_amount)::text AS mdr,sum(amount)::text AS gross
        FROM sport_center.sport_payments WHERE id IN (859,860,861,862)
      `);
      expect(Number(source.rows[0]?.mdr)).toBe(6300);
      expect(Number(source.rows[0]?.gross)).toBe(930000);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  });
});
