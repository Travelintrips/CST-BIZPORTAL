import { describe, it, expect } from "vitest";
import pg from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { reverseCanonicalSettlementForCorrection } from "../lib/reconciliation/canonicalSettlementCorrection";

const local = process.env.QRIS292_ISOLATED_PG_URL;
const suite = local ? describe : describe.skip;
const dialect = new PgDialect();
const input = {
  settlementId: 5738,
  expectedBankMutationId: 434464,
  replacementPaymentIds: [859,860,861,862],
  actor: "qris292-isolated-integration",
  reason: "Isolated PostgreSQL verification without modifying DEV or PROD financial data",
};
suite("Issue 292 actual TypeScript writer in isolated PostgreSQL", () => {
  it("executes real SQL reversal and inspects its journal before rolling back", async () => {
    const conn = new pg.Client({connectionString:local});
    await conn.connect();
    await conn.query("BEGIN");
    const tx = {
      execute: async (statement: any) => {
        const compiled = dialect.sqlToQuery(statement);
        return conn.query(compiled.sql, compiled.params);
      },
    };
    try {
      const outcome = await reverseCanonicalSettlementForCorrection({
        transaction: async (callback: any) => callback(tx),
      } as any,input);
      expect(outcome.ok).toBe(true);
      const inspect = await conn.query(`
        SELECT b.status,
          (SELECT count(*)::int FROM sport_center.accounting_journals j WHERE j.reversal_of_id=7207 AND j.status='posted') AS reversal_count,
          (SELECT count(*)::int FROM sport_center.payment_settlement_items i WHERE i.settlement_id=5738 AND i.item_status='reversed') AS old_reversed,
          (SELECT count(*)::int FROM public.bank_reconciliation_audit a WHERE a.action='CANONICAL_SETTLEMENT_MEMBERSHIP_CORRECTION_REVERSED') AS audit_count
        FROM sport_center.payment_settlement_batches b WHERE b.id=5738`);
      expect(inspect.rows[0]).toMatchObject({status:"reversed",reversal_count:1,old_reversed:4,audit_count:1});
      // Verify actual debit/credit directions and immutable source journal,
      // not merely the existence of a posted compensation record.
      const lines = await conn.query(`
        SELECT j.id, j.reversal_of_id, j.status, l.line_type, l.account_code, l.amount::numeric AS amount
        FROM sport_center.accounting_journals j
        JOIN sport_center.accounting_journal_lines l ON l.journal_id=j.id
        WHERE j.id=7207 OR j.reversal_of_id=7207
        ORDER BY j.id, l.account_code
      `);
      const original = lines.rows.filter((r:any) => r.id===7207);
      const reversal = lines.rows.filter((r:any) => r.reversal_of_id===7207);
      expect(original).toHaveLength(2);
      expect(reversal).toHaveLength(2);
      expect(original.map((r:any) => [r.account_code,r.line_type,Number(r.amount)]))
        .toEqual([["1001","debit",923700],["4001","credit",923700]]);
      expect(reversal.map((r:any) => [r.account_code,r.line_type,Number(r.amount)]))
        .toEqual([["1001","credit",923700],["4001","debit",923700]]);
      expect(reversal.every((r:any) => r.status==="posted")).toBe(true);
      const bankAfter = await conn.query("SELECT status, reconciliation_status, review_code FROM public.bank_mutations WHERE id=434464");
      expect(bankAfter.rows[0]).toMatchObject({
        status:"unmatched",reconciliation_status:"unmatched",review_code:"QRIS_MEMBERSHIP_CORRECTION_PENDING",
      });
    } finally {await conn.query("ROLLBACK"); await conn.end();}
    const check = new pg.Client({connectionString:local});
    await check.connect();
    try {
      const rows = await check.query("SELECT count(*)::int AS n FROM sport_center.accounting_journals WHERE reversal_of_id=7207");
      expect(rows.rows[0].n).toBe(0);
    } finally {await check.end();}
  });
  it("rolls back every financial mutation when audit persistence fails", async () => {
    const conn = new pg.Client({connectionString:local});
    await conn.connect();
    await conn.query("BEGIN");
    const tx = {
      execute: async (statement: any) => {
        const query = dialect.sqlToQuery(statement);
        if (query.sql.includes("INSERT INTO public.bank_reconciliation_audit")) {
          throw new Error("INJECTED_AUDIT_FAILURE");
        }
        return conn.query(query.sql,query.params);
      },
    };
    try {
      await expect(reverseCanonicalSettlementForCorrection({
        transaction: async (callback: any) => callback(tx),
      } as any,input)).rejects.toThrow("INJECTED_AUDIT_FAILURE");
    } finally {
      await conn.query("ROLLBACK");
      await conn.end();
    }
    const check = new pg.Client({connectionString:local});
    await check.connect();
    try {
      const snapshot = await check.query(`
        SELECT b.status,
          (SELECT count(*)::integer FROM sport_center.accounting_journals WHERE reversal_of_id=7207) AS reversals,
          (SELECT count(*)::integer FROM sport_center.payment_settlement_items WHERE settlement_id=5738 AND item_status='active') AS active_items,
          (SELECT status FROM public.bank_mutations WHERE id=434464) AS mutation_status,
          (SELECT count(*)::integer FROM public.bank_reconciliation_audit WHERE action='CANONICAL_SETTLEMENT_MEMBERSHIP_CORRECTION_REVERSED') AS audit_count
        FROM sport_center.payment_settlement_batches b WHERE b.id=5738`);
      expect(snapshot.rows[0]).toMatchObject({status:'posted',reversals:0,active_items:4,mutation_status:'matched',audit_count:0});
    } finally {await check.end();}
  });

  it("is idempotent for the same bank and payment set, and rejects changed retry identity", async () => {
    const conn = new pg.Client({connectionString:local});
    await conn.connect();
    await conn.query("BEGIN");
    const tx = { execute: async (statement: any) => {
      const compiled = dialect.sqlToQuery(statement);
      return conn.query(compiled.sql, compiled.params);
    }};
    const client = {transaction: async (callback: any) => callback(tx)} as any;
    try {
      const first = await reverseCanonicalSettlementForCorrection(client,input);
      expect(first.idempotent).toBe(false);
      const repeated = await reverseCanonicalSettlementForCorrection(client,input);
      expect(repeated.idempotent).toBe(true);
      expect(repeated.reversedSettlementJournalId).toBe(first.reversedSettlementJournalId);
      await expect(reverseCanonicalSettlementForCorrection(client,{
        ...input, replacementPaymentIds: [856,859,860,861],
      })).rejects.toThrow("Idempotent reversal request does not match");
      await expect(reverseCanonicalSettlementForCorrection(client,{
        ...input, expectedBankMutationId:434462,
      })).rejects.toThrow("Idempotent reversal request does not match");
      const check = await conn.query("SELECT count(*)::int AS n FROM sport_center.accounting_journals WHERE reversal_of_id=7207");
      expect(check.rows[0].n).toBe(1);
    } finally {await conn.query("ROLLBACK");await conn.end();}
  });

  it("fails closed for wrong bank transaction date before inserting a reversal journal", async () => {
    const conn = new pg.Client({connectionString:local});
    await conn.connect();
    await conn.query("BEGIN");
    const tx = { execute: async (statement: any) => {
      const compiled = dialect.sqlToQuery(statement);
      return conn.query(compiled.sql, compiled.params);
    }};
    try {
      await conn.query("UPDATE public.bank_mutations SET transaction_date='2026-11-06' WHERE id=434464");
      await expect(reverseCanonicalSettlementForCorrection({
        transaction: async (callback: any) => callback(tx),
      } as any,input)).rejects.toThrow("unapproved bank mutation with matching owner/date");
      const check = await conn.query("SELECT count(*)::int AS n FROM sport_center.accounting_journals WHERE reversal_of_id=7207");
      expect(check.rows[0].n).toBe(0);
    } finally {await conn.query("ROLLBACK");await conn.end();}
  });

});
