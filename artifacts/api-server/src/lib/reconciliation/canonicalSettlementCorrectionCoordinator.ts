import { sql } from "drizzle-orm";
import { reverseCanonicalSettlementForCorrection } from "./canonicalSettlementCorrection";
import type {
  CanonicalSettlementCorrectionInput,
  CanonicalSettlementCorrectionResult,
} from "./canonicalSettlementCorrection";

type DbClient = typeof import("@workspace/db").db;
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/**
 * A transaction boundary for the complete QRIS membership correction.
 *
 * IMPORTANT: this is intentionally NOT exposed through a route. The caller must
 * supply existing authenticated canonical batch-build and bank-approval operations
 * that use the SAME transaction handle. Never call a global DB connection from a
 * stage, or commit a reversal independently of its replacements.
 *
 * Once those operations have been wired and the two-bank end-to-end checks pass,
 * the integration can use this coordinator. Until then PR #296 stays draft.
 */
export async function runAtomicCanonicalSettlementCorrection<TBatches, TApprovals>(
  client: DbClient,
  input: CanonicalSettlementCorrectionInput,
  stages: {
    rebuildBothDatedBatches: (
      tx: Transaction,
      reversal: CanonicalSettlementCorrectionResult,
    ) => Promise<TBatches>;
    approveBothCanonicalBankMatches: (
      tx: Transaction,
      batches: TBatches,
      reversal: CanonicalSettlementCorrectionResult,
    ) => Promise<TApprovals>;
  },
): Promise<{
  reversal: CanonicalSettlementCorrectionResult;
  batches: TBatches;
  approvals: TApprovals;
}> {
  if (!stages || typeof stages.rebuildBothDatedBatches !== "function"
    || typeof stages.approveBothCanonicalBankMatches !== "function") {
    throw new Error("Both canonical replacement and bank approval stages are required.");
  }
  return client.transaction(async (tx) => {
    // The reversal writer's existing transaction entry point is reused, but its
    // callback receives the already-open outer tx. It cannot commit early.
    const scoped = {
      transaction: async <T>(callback: (innerTx: Transaction) => Promise<T>) => callback(tx),
    } as unknown as DbClient;
    const reversal = await reverseCanonicalSettlementForCorrection(scoped, input);
    if (!reversal.ok || reversal.settlementStatus !== "reversed") {
      throw new Error("Settlement reversal stage did not complete.");
    }
    const batches = await stages.rebuildBothDatedBatches(tx, reversal);
    const approvals = await stages.approveBothCanonicalBankMatches(tx, batches, reversal);
    // Issue #292 is deliberately restricted to the verified historical case.
    // A stage callback returning without doing the finance work must NEVER
    // commit the reversal. Re-read canonical DB records within the same tx.
    if (input.settlementId !== 5738 || input.expectedBankMutationId !== 434464
      || [...input.replacementPaymentIds].sort((a,b)=>a-b).join(",") !== "859,860,861,862") {
      throw new Error("Issue #292 coordinator rejects non-approved correction identity.");
    }
    const expected = [
      {mutationId:434462, date:"2026-11-04", ids:[834,843,853,856,858], gross:690000, mdr:4200, net:685800},
      {mutationId:434464, date:"2026-11-05", ids:[859,860,861,862], gross:930000, mdr:6300, net:923700},
    ];
    const used = new Set<number>();
    for (const cohort of expected) {
      const result = await tx.execute(sql`
        SELECT b.id AS batch_id, b.status::text AS batch_status,
          b.settlement_date::text AS settlement_date,
          b.gross_amount, b.mdr_amount, b.net_amount,
          b.settlement_journal_id, j.status::text AS journal_status,
          j.is_reversal, m.status::text AS bank_status,
          m.amount AS bank_amount, m.journal_entry_id,
          COALESCE(array_agg(i.payment_id ORDER BY i.payment_id)
            FILTER (WHERE i.payment_id IS NOT NULL),ARRAY[]::integer[]) AS payment_ids
        FROM sport_center.payment_settlement_batches b
        JOIN sport_center.accounting_journals j ON j.id=b.settlement_journal_id
        JOIN public.bank_mutations m ON m.id=b.bank_mutation_id
        LEFT JOIN sport_center.payment_settlement_items i
          ON i.settlement_id=b.id AND i.item_status='active'
        WHERE b.bank_mutation_id=${cohort.mutationId} AND b.company_id=1
        GROUP BY b.id,j.id,m.id
      `);
      if (result.rows.length !== 1) {
        throw new Error(`Issue #292 missing or duplicate canonical bank batch for ${cohort.mutationId}.`);
      }
      const row = result.rows[0] as Record<string,unknown>;
      const actualIds = (row.payment_ids as Array<number|string>).map(Number).sort((a,b)=>a-b);
      const valid = Number(row.batch_id) !== 5738
        && row.batch_status === "reconciled" && row.bank_status === "approved"
        && row.journal_status === "posted" && row.is_reversal === false
        && row.journal_entry_id == null
        && row.settlement_date === cohort.date
        && Number(row.gross_amount) === cohort.gross
        && Number(row.mdr_amount) === cohort.mdr
        && Number(row.net_amount) === cohort.net
        && Number(row.bank_amount) === cohort.net
        && actualIds.join(",") === cohort.ids.join(",");
      if (!valid || used.has(Number(row.batch_id))) {
        throw new Error(`Issue #292 canonical bank or membership postcondition failed: ${cohort.mutationId}.`);
      }
      // Posted alone is not sufficient: verify a nonzero balanced ledger
      // for every replacement settlement journal before the outer commit.
      const ledger = await tx.execute(sql`
        SELECT COALESCE(SUM(amount) FILTER (WHERE line_type='debit'),0) AS debits,
               COALESCE(SUM(amount) FILTER (WHERE line_type='credit'),0) AS credits,
               COUNT(*)::integer AS lines
        FROM sport_center.accounting_journal_lines
        WHERE journal_id=${Number(row.settlement_journal_id)}
      `);
      const amounts = ledger.rows[0] as Record<string,unknown>|undefined;
      if (!amounts || Number(amounts.lines)<2 || Number(amounts.debits)<=0
        || Number(amounts.debits)!==Number(amounts.credits)
        || Number(amounts.debits)!==cohort.net) {
        throw new Error(`Issue #292 posted settlement journal is unbalanced or does not equal bank net: ${cohort.mutationId}.`);
      }
      used.add(Number(row.batch_id));
    }
    const original = await tx.execute(sql`
      SELECT b.status::text AS status,
        (SELECT count(*)::integer FROM sport_center.payment_settlement_items
          WHERE settlement_id=5738 AND item_status='active') AS active_members,
        (SELECT count(*)::integer FROM sport_center.accounting_journals
          WHERE reversal_of_id=b.settlement_journal_id AND is_reversal=true
            AND status='posted') AS posted_reversals
      FROM sport_center.payment_settlement_batches b WHERE b.id=5738
    `);
    const state = original.rows[0] as Record<string,unknown>|undefined;
    if (!state || state.status !== "reversed" || Number(state.active_members)!==0
      || Number(state.posted_reversals)!==1) {
      throw new Error("Issue #292 original posted settlement correction incomplete.");
    }
    return { reversal, batches, approvals };
  });
}
