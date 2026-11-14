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
    return { reversal, batches, approvals };
  });
}
