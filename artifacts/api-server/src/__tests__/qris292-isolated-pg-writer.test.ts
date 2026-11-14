import { describe, it, expect } from "vitest";
import pg from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { reverseCanonicalSettlementForCorrection } from "../lib/reconciliation/canonicalSettlementCorrection";
import { runAtomicCanonicalSettlementCorrection } from "../lib/reconciliation/canonicalSettlementCorrectionCoordinator";

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

  it("rolls back reversal and replacement if approval fails after rebuilding", async () => {
    const conn = new pg.Client({connectionString:local});
    await conn.connect();
    await conn.query("BEGIN");
    const tx = {execute: async (statement: any) => {
      const compiled = dialect.sqlToQuery(statement);
      return conn.query(compiled.sql,compiled.params);
    }};
    const db = {transaction: async (callback: any) => {
      try {
        const result = await callback(tx);
        await conn.query("COMMIT");
        return result;
      } catch (e) {
        await conn.query("ROLLBACK");
        throw e;
      }
    }} as any;
    try {
      await expect(runAtomicCanonicalSettlementCorrection(db,input,{
        rebuildBothDatedBatches: async () => {
          // Synthetic replacement only. This is NOT the canonical PROD builder.
          await conn.query(`
            INSERT INTO sport_center.payment_settlement_batches
              (id,company_id,status,settlement_date,provider_code,bank_account_id,
               settlement_rule_version,gross_amount,mdr_amount,net_amount)
            VALUES(5739,1,'calculated','2026-11-05','mandiri_direct','1640006707220',
                   'PROD-MANDIRI-SC-20260831-v1',930000,6300,923700)
          `);
          await conn.query(`
            INSERT INTO sport_center.payment_settlement_items(settlement_id,payment_id,item_status,gross_amount)
            SELECT 5739,id,'active',amount FROM sport_center.sport_payments
            WHERE id IN (859,860,861,862)
          `);
          return {replacementBatchIds:[5739]};
        },
        approveBothCanonicalBankMatches: async () => {
          const inside = await conn.query(`
            SELECT (SELECT status FROM sport_center.payment_settlement_batches WHERE id=5738)
              AS old_status,
              (SELECT count(*)::int FROM sport_center.payment_settlement_items
               WHERE settlement_id=5739 AND item_status='active') AS replacement_items
          `);
          expect(inside.rows[0]).toMatchObject({old_status:"reversed",replacement_items:4});
          throw new Error("INJECTED_DOWNSTREAM_APPROVAL_FAILURE");
        },
      })).rejects.toThrow("INJECTED_DOWNSTREAM_APPROVAL_FAILURE");
    } finally {
      // Already rolled back by the outer transaction handler.
      await conn.end();
    }
    const check = new pg.Client({connectionString:local});
    await check.connect();
    try {
      const state = await check.query(`
        SELECT b.status,
          (SELECT count(*)::int FROM sport_center.accounting_journals
           WHERE reversal_of_id=7207) AS reversals,
          (SELECT count(*)::int FROM sport_center.payment_settlement_batches
           WHERE id=5739) AS replacement_batches,
          (SELECT count(*)::int FROM sport_center.payment_settlement_items
           WHERE settlement_id=5738 AND item_status='active') AS old_active,
          (SELECT status FROM public.bank_mutations WHERE id=434464) AS bank_status,
          (SELECT count(*)::int FROM public.bank_reconciliation_audit
           WHERE action='CANONICAL_SETTLEMENT_MEMBERSHIP_CORRECTION_REVERSED') AS audit_rows
        FROM sport_center.payment_settlement_batches b WHERE b.id=5738
      `);
      expect(state.rows[0]).toMatchObject({
        status:"posted",reversals:0,replacement_batches:0,
        old_active:4,bank_status:"matched",audit_rows:0,
      });
    } finally {await check.end();}
  });


  it("rebuilds both dated synthetic cohorts and rolls back if the second bank match fails", async () => {
    const conn = new pg.Client({connectionString:local});
    await conn.connect();
    await conn.query("BEGIN");
    const tx = {execute: async (statement: any) => {
      const compiled = dialect.sqlToQuery(statement);
      return conn.query(compiled.sql,compiled.params);
    }};
    const db = {transaction: async (callback: any) => {
      try {
        const result = await callback(tx);
        await conn.query("COMMIT");
        return result;
      } catch (e) {
        await conn.query("ROLLBACK");
        throw e;
      }
    }} as any;
    try {
      // Add the missing Nov 4 cohort to the isolated synthetic fixture.
      // No DEV/PROD database, bank API, or real user payment is involved.
      await conn.query(`
        UPDATE sport_center.sport_payments
        SET amount=300000,mdr_amount=2100 WHERE id=856;
        INSERT INTO sport_center.sport_payments
          (id,company_id,amount,status,settlement_status,payment_method,
           payment_provider,bank_account_id,paid_at,expected_settlement_date,
           settlement_rule_version,mdr_amount)
        VALUES
          (834,1,30000,'confirmed','unsettled','qris','mandiri_direct','1640006707220','2026-11-03 10:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',0),
          (843,1,30000,'confirmed','unsettled','qris','mandiri_direct','1640006707220','2026-11-03 11:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',0),
          (853,1,30000,'confirmed','unsettled','qris','mandiri_direct','1640006707220','2026-11-03 13:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',0),
          (858,1,300000,'confirmed','unsettled','qris','mandiri_direct','1640006707220','2026-11-03 14:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',2100);
        INSERT INTO public.bank_mutations
          (id,status,company_id,amount,transaction_date,source_classification,
           direction,bank_account_id,reconciliation_status)
        VALUES(434462,'unmatched',1,685800,'2026-11-04',
               'actual_bank_mutation','IN','17','unmatched');
      `);
      await expect(runAtomicCanonicalSettlementCorrection(db,input,{
        rebuildBothDatedBatches: async () => {
          await conn.query(`
            INSERT INTO sport_center.payment_settlement_batches
              (id,company_id,status,settlement_date,provider_code,bank_account_id,
               settlement_rule_version,gross_amount,mdr_amount,net_amount)
            VALUES
              (5739,1,'calculated','2026-11-04','mandiri_direct','1640006707220','PROD-MANDIRI-SC-20260831-v1',690000,4200,685800),
              (5740,1,'calculated','2026-11-05','mandiri_direct','1640006707220','PROD-MANDIRI-SC-20260831-v1',930000,6300,923700);
            INSERT INTO sport_center.payment_settlement_items(settlement_id,payment_id,item_status,gross_amount)
            SELECT 5739,id,'active',amount FROM sport_center.sport_payments
            WHERE id IN (834,843,853,856,858);
            INSERT INTO sport_center.payment_settlement_items(settlement_id,payment_id,item_status,gross_amount)
            SELECT 5740,id,'active',amount FROM sport_center.sport_payments
            WHERE id IN (859,860,861,862);
          `);
          const cohorts = await conn.query(`
            SELECT b.settlement_date::text AS day,COUNT(i.payment_id)::int AS members,
              SUM(p.amount)::numeric AS gross,SUM(p.mdr_amount)::numeric AS mdr,
              (SUM(p.amount)-SUM(p.mdr_amount))::numeric AS net
            FROM sport_center.payment_settlement_batches b
            JOIN sport_center.payment_settlement_items i ON i.settlement_id=b.id AND i.item_status='active'
            JOIN sport_center.sport_payments p ON p.id=i.payment_id
            WHERE b.id IN (5739,5740)
            GROUP BY b.id,b.settlement_date ORDER BY b.settlement_date
          `);
          expect(cohorts.rows.map((r:any) => [r.day,r.members,Number(r.gross),Number(r.mdr),Number(r.net)]))
            .toEqual([
              ["2026-11-04",5,690000,4200,685800],
              ["2026-11-05",4,930000,6300,923700],
            ]);
          return {batchIds:[5739,5740]};
        },
        approveBothCanonicalBankMatches: async () => {
          // Simulate the first bank update within the outer transaction,
          // then inject failure at the second bank; NOT real canonical approval.
          await conn.query("UPDATE public.bank_mutations SET status='matched' WHERE id=434462");
          const first = await conn.query("SELECT status FROM public.bank_mutations WHERE id=434462");
          expect(first.rows[0].status).toBe("matched");
          throw new Error("INJECTED_SECOND_BANK_APPROVAL_FAILURE");
        },
      })).rejects.toThrow("INJECTED_SECOND_BANK_APPROVAL_FAILURE");
    } finally {await conn.end();}
    const check = new pg.Client({connectionString:local});
    await check.connect();
    try {
      const state = await check.query(`
        SELECT b.status,
          (SELECT count(*)::int FROM sport_center.accounting_journals
           WHERE reversal_of_id=7207) AS reversal_journals,
          (SELECT count(*)::int FROM sport_center.payment_settlement_batches
           WHERE id IN (5739,5740)) AS replacement_batches,
          (SELECT count(*)::int FROM sport_center.payment_settlement_items
           WHERE settlement_id=5738 AND item_status='active') AS original_active,
          (SELECT count(*)::int FROM sport_center.sport_payments
           WHERE id IN (834,843,853,858)) AS added_payments,
          (SELECT count(*)::int FROM public.bank_mutations WHERE id=434462) AS added_bank,
          (SELECT status FROM public.bank_mutations WHERE id=434464) AS original_bank_status,
          (SELECT count(*)::int FROM public.bank_reconciliation_audit
           WHERE action='CANONICAL_SETTLEMENT_MEMBERSHIP_CORRECTION_REVERSED') AS audit_rows
        FROM sport_center.payment_settlement_batches b WHERE b.id=5738
      `);
      expect(state.rows[0]).toMatchObject({
        status:"posted",reversal_journals:0,replacement_batches:0,
        original_active:4,added_payments:0,added_bank:0,
        original_bank_status:"matched",audit_rows:0,
      });
    } finally {await check.end();}
  });

  it("refuses to commit a reversal if replacement and approval callbacks return without real bank links", async () => {
    const conn = new pg.Client({connectionString:local});
    await conn.connect();
    await conn.query("BEGIN");
    const tx = {execute: async (statement:any) => {
      const compiled = dialect.sqlToQuery(statement);
      return conn.query(compiled.sql,compiled.params);
    }};
    const db = {transaction: async (callback:any) => {
      try {
        const result = await callback(tx);
        await conn.query("COMMIT");
        return result;
      } catch (e) {
        await conn.query("ROLLBACK");
        throw e;
      }
    }} as any;
    try {
      await expect(runAtomicCanonicalSettlementCorrection(db,input,{
        rebuildBothDatedBatches: async () => ({pretendedComplete:true}),
        approveBothCanonicalBankMatches: async () => ({pretendedApproved:true}),
      })).rejects.toThrow("missing or duplicate canonical bank batch");
    } finally {await conn.end();}
    const check = new pg.Client({connectionString:local});
    await check.connect();
    try {
      const state = await check.query(`
        SELECT b.status,
          (SELECT count(*)::int FROM sport_center.accounting_journals
           WHERE reversal_of_id=7207) AS reversal_journals,
          (SELECT count(*)::int FROM public.bank_reconciliation_audit
           WHERE action='CANONICAL_SETTLEMENT_MEMBERSHIP_CORRECTION_REVERSED') AS audit_count
        FROM sport_center.payment_settlement_batches b WHERE b.id=5738
      `);
      expect(state.rows[0]).toMatchObject({status:"posted",reversal_journals:0,audit_count:0});
    } finally {await check.end();}
  });


  it("accepts the exact two-bank synthetic completion with balanced posted settlement journals", async () => {
    const conn = new pg.Client({connectionString:local});
    await conn.connect();
    await conn.query("BEGIN");
    const tx = {execute: async (statement:any) => {
      const compiled = dialect.sqlToQuery(statement);
      return conn.query(compiled.sql,compiled.params);
    }};
    const db = {transaction: async (callback:any) => callback(tx)} as any;
    try {
      // These are isolated fixture rows, NOT the production builder/approval functions.
      await conn.query(`
        INSERT INTO sport_center.sport_payments
          (id,company_id,amount,status,settlement_status,payment_method,
           payment_provider,bank_account_id,paid_at,expected_settlement_date,
           settlement_rule_version,mdr_amount)
        VALUES
          (834,1,30000,'confirmed','unsettled','qris','mandiri_direct','1640006707220','2026-11-03 10:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',0),
          (843,1,30000,'confirmed','unsettled','qris','mandiri_direct','1640006707220','2026-11-03 11:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',0),
          (853,1,30000,'confirmed','unsettled','qris','mandiri_direct','1640006707220','2026-11-03 13:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',0),
          (858,1,300000,'confirmed','unsettled','qris','mandiri_direct','1640006707220','2026-11-03 14:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',2100);
        INSERT INTO public.bank_mutations
          (id,status,company_id,amount,transaction_date,source_classification,
           direction,bank_account_id,reconciliation_status)
        VALUES(434462,'unmatched',1,685800,'2026-11-04',
               'actual_bank_mutation','IN','17','unmatched');
      `);
      const result = await runAtomicCanonicalSettlementCorrection(db,input,{
        rebuildBothDatedBatches: async () => {
          await conn.query(`
            INSERT INTO sport_center.payment_settlement_batches
              (id,company_id,status,settlement_date,provider_code,bank_account_id,
               settlement_rule_version,gross_amount,mdr_amount,net_amount)
            VALUES
              (5739,1,'calculated','2026-11-04','mandiri_direct','1640006707220','PROD-MANDIRI-SC-20260831-v1',690000,4200,685800),
              (5740,1,'calculated','2026-11-05','mandiri_direct','1640006707220','PROD-MANDIRI-SC-20260831-v1',930000,6300,923700);
            INSERT INTO sport_center.payment_settlement_items(settlement_id,payment_id,item_status,gross_amount)
            SELECT 5739,id,'active',amount FROM sport_center.sport_payments
            WHERE id IN (834,843,853,856,858);
            INSERT INTO sport_center.payment_settlement_items(settlement_id,payment_id,item_status,gross_amount)
            SELECT 5740,id,'active',amount FROM sport_center.sport_payments
            WHERE id IN (859,860,861,862);
          `);
          // The fixture substitutes balanced journals for the canonical
          // create_settlement_journal_draft/finalize functions.
          const journals = await conn.query(`
            INSERT INTO sport_center.accounting_journals
              (journal_type,status,is_reversal,settlement_batch_id,notes,
               debit_amount,credit_revenue_amount,credit_ppn_amount)
            VALUES
              ('settlement','draft',false,5739,'TEST COHORT NOV4',685800,685800,0),
              ('settlement','draft',false,5740,'TEST COHORT NOV5',923700,923700,0)
            RETURNING id,settlement_batch_id
          `);
          for (const j of journals.rows) {
            const amount = Number(j.settlement_batch_id)===5739 ? 685800 : 923700;
            await conn.query(`
              INSERT INTO sport_center.accounting_journal_lines
                (journal_id,line_type,account_code,account_name,amount,description)
              VALUES($1,'debit','1001','clearing',$2,'synthetic bank'),
                    ($1,'credit','4001','revenue',$2,'synthetic settlement')
            `,[j.id,amount]);
            await conn.query("SELECT sport_center.validate_accounting_journal($1)",[j.id]);
            await conn.query("UPDATE sport_center.accounting_journals SET status='posted' WHERE id=$1",[j.id]);
            await conn.query(`
              UPDATE sport_center.payment_settlement_batches
              SET settlement_journal_id=$1,status='posted' WHERE id=$2
            `,[j.id,j.settlement_batch_id]);
          }
          return {ids:[5739,5740]};
        },
        approveBothCanonicalBankMatches: async (_tx,batches) => {
          for (const [batchId,mutationId] of [[5739,434462],[5740,434464]]) {
            await conn.query(`
              UPDATE sport_center.payment_settlement_batches
              SET bank_mutation_id=$1,canonical_bank_mutation_id=$1,status='reconciled'
              WHERE id=$2 AND status='posted'
            `,[mutationId,batchId]);
            await conn.query(`
              UPDATE public.bank_mutations
              SET status='approved',reconciliation_status='approved'
              WHERE id=$1 AND journal_entry_id IS NULL
            `,[mutationId]);
          }
          return {approved:[434462,434464],batches};
        },
      });
      expect(result.reversal.ok).toBe(true);
      expect(result.batches.ids).toEqual([5739,5740]);
      const bank = await conn.query(`
        SELECT COALESCE(SUM(amount),0)::numeric AS net FROM public.bank_mutations
        WHERE id IN (434462,434464) AND status='approved'
      `);
      expect(Number(bank.rows[0].net)).toBe(1609500);
      const original = await conn.query(`
        SELECT status FROM sport_center.payment_settlement_batches WHERE id=5738
      `);
      expect(original.rows[0].status).toBe("reversed");
    } finally {
      await conn.query("ROLLBACK");
      await conn.end();
    }
    const check = new pg.Client({connectionString:local});
    await check.connect();
    try {
      const readback = await check.query(`
        SELECT (SELECT status FROM sport_center.payment_settlement_batches WHERE id=5738) AS original_status,
          (SELECT count(*)::int FROM sport_center.payment_settlement_batches WHERE id IN (5739,5740)) AS replacements,
          (SELECT count(*)::int FROM sport_center.accounting_journals WHERE reversal_of_id=7207) AS reversals
      `);
      expect(readback.rows[0]).toMatchObject({original_status:"posted",replacements:0,reversals:0});
    } finally {await check.end();}
  });

  it("distinguishes SC-1707 Nov 4 and SC-1720 Nov 5 from actual paid_at using Jakarta H+1", async () => {
    const conn = new pg.Client({connectionString:local});
    await conn.connect();
    try {
      const evidence = await conn.query(`
        SELECT id,
          expected_settlement_date::text AS expected_date,
          ((paid_at AT TIME ZONE 'Asia/Jakarta')::date + 1)::text AS actual_h_plus_one_date
        FROM sport_center.sport_payments WHERE id IN (856,862) ORDER BY id
      `);
      expect(evidence.rows).toEqual([
        {id:856,expected_date:"2026-11-04",actual_h_plus_one_date:"2026-11-04"},
        {id:862,expected_date:"2026-11-05",actual_h_plus_one_date:"2026-11-05"},
      ]);
      expect(evidence.rows[0].actual_h_plus_one_date).not.toBe("2026-11-05");
    } finally {await conn.end();}
  });

  it("rejects wrong replacement MDR before writing any compensating journal", async () => {
    const conn = new pg.Client({connectionString:local});
    await conn.connect();
    await conn.query("BEGIN");
    const tx = { execute: async (statement: any) => {
      const compiled = dialect.sqlToQuery(statement);
      return conn.query(compiled.sql, compiled.params);
    }};
    try {
      await conn.query("UPDATE sport_center.sport_payments SET mdr_amount=2101 WHERE id=862");
      await expect(reverseCanonicalSettlementForCorrection({
        transaction: async (callback: any) => callback(tx),
      } as any,input)).rejects.toThrow("Replacement cohort gross/MDR/net");
      const check = await conn.query(`
        SELECT b.status,
          (SELECT count(*)::int FROM sport_center.accounting_journals WHERE reversal_of_id=7207) AS reversals,
          (SELECT count(*)::int FROM sport_center.payment_settlement_items WHERE settlement_id=5738 AND item_status='active') AS active_items
        FROM sport_center.payment_settlement_batches b WHERE b.id=5738
      `);
      expect(check.rows[0]).toMatchObject({status:"posted",reversals:0,active_items:4});
    } finally {await conn.query("ROLLBACK"); await conn.end();}
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
