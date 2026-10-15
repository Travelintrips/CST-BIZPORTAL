import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../routes/bank-reconciliation.ts', import.meta.url)), 'utf8');
const sweep = source.slice(source.indexOf('export async function runQrisAutoCandidateSweep'), source.indexOf('router.post("/bank-reconciliation/:mutationId/qris-canonical/prepare"'));

describe('canonical QRIS automatic approval regression', () => {
  it('approves a uniquely recovered exact canonical settlement before commit', () => {
    expect(sweep).toContain('if (!ambiguous) {');
    expect(sweep).toMatch(/if \(!ambiguous\)[\s\S]*?approveCanonicalSettlementLink\([\s\S]*?await client\.query\("commit"\)/);
  });
  it('approves an exactly verified live cohort atomically after preparation', () => {
    expect(sweep).toMatch(/const prepared = await prepareCanonicalQrisSettlement\([\s\S]*?await approveCanonicalSettlementLink\([\s\S]*?await client\.query\("commit"\)/);
  });
  it('does not automatically approve ambiguous or non-exact cohorts', () => {
    expect(sweep).toContain('summary.noExactCandidate += 1');
    expect(sweep).toContain('summary.ambiguousExistingSettlements += 1');
    expect(source).toContain('CANONICAL_SETTLEMENT_AMOUNT_MISMATCH');
    expect(source).toContain('CANONICAL_SETTLEMENT_ALREADY_USED');
  });
});
