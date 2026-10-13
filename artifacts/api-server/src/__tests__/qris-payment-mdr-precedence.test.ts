import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../lib/reconciliation/qrisReviewDiagnostics.ts', import.meta.url)), 'utf8');
describe('live QRIS payment MDR', () => {
  it('uses the stored per-payment MDR rate including zero before provider defaults', () => {
    expect(source).toContain('coalesce(sp.mdr_rate, config.mdr_rate, 0.007)::numeric as mdr_rate');
  });
});
