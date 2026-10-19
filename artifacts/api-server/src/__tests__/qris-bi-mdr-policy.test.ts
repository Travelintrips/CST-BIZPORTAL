import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { calculateQrisMdr, sumQrisSettlementMdr, calculateQrisCandidatePreview } from '../lib/reconciliation/qrisMdrPolicy';

describe('BI QRIS MDR effective 2026-10-01', () => {
  it('does not charge MDR for three separate Rp30k gym payments', () => {
    const payment = {amount:30000,transactionDate:'2026-10-10',merchantCategory:'regular' as const};
    expect(sumQrisSettlementMdr([payment,payment,payment])).toBe(0);
  });
  it('preserves October 9 four-payment Mandiri settlement', () => {
    expect(sumQrisSettlementMdr([350000,320000,300000,350000].map(amount => ({amount,transactionDate:'2026-10-09',merchantCategory:'regular' as const})))).toBe(9240);
  });
  it('treats exactly Rp100k as MDR free, but Rp100001 as fee-bearing', () => {
    expect(calculateQrisMdr({amount:100000,transactionDate:'2026-10-01',merchantCategory:'regular'})).toBe(0);
    expect(calculateQrisMdr({amount:100001,transactionDate:'2026-10-01',merchantCategory:'regular'})).toBe(700);
  });
  it('does not backdate the new exemption', () => {
    expect(calculateQrisMdr({amount:30000,transactionDate:'2026-09-30',merchantCategory:'regular'})).toBe(210);
  });
  it('retains the UMI Rp500k threshold', () => {
    expect(calculateQrisMdr({amount:500000,transactionDate:'2026-10-10',merchantCategory:'micro'})).toBe(0);
    expect(calculateQrisMdr({amount:600000,transactionDate:'2026-10-10',merchantCategory:'micro'})).toBe(1800);
  });
  it('rejects invalid inputs', () => {
    expect(() => calculateQrisMdr({amount:-1,transactionDate:'2026-10-10',merchantCategory:'regular'})).toThrow();
  });
  it('does not finalize MDR before all candidates are present', () => {
    const payments = [{id:1,amount:30000,transactionDate:'2026-10-10',merchantCategory:'regular' as const}];
    expect(calculateQrisCandidatePreview({payments,candidatesComplete:false}).mdrAmount).toBeNull();
    expect(calculateQrisCandidatePreview({payments,candidatesComplete:true}).mdrAmount).toBe(0);
  });
  it('recalculates MDR after candidate amount or membership changes', () => {
    const make = (id:number,amount:number) => ({id,amount,transactionDate:'2026-10-09',merchantCategory:'regular' as const});
    expect(calculateQrisCandidatePreview({payments:[make(1,30000),make(2,350000)],candidatesComplete:true}).mdrAmount).toBe(2450);
    expect(calculateQrisCandidatePreview({payments:[make(1,150000),make(2,350000)],candidatesComplete:true}).mdrAmount).toBe(3500);
    expect(calculateQrisCandidatePreview({payments:[make(1,150000)],candidatesComplete:true}).mdrAmount).toBe(1050);
  });
  it('rejects duplicate candidate entries', () => {
    const p = {id:1,amount:30000,transactionDate:'2026-10-10',merchantCategory:'regular' as const};
    expect(() => calculateQrisCandidatePreview({payments:[p,p],candidatesComplete:true})).toThrow(/Duplicate/);
  });
  it('guards canonical preparation against source MDR mismatches before journal promotion', () => {
    const source = readFileSync(resolve(process.cwd(),'src/routes/bank-reconciliation.ts'),'utf8');
    expect(source).toContain('QRIS_SOURCE_MDR_INCOMPLETE');
    expect(source).toContain('QRIS_SOURCE_NET_MISMATCH');
    const prepare = source.slice(source.indexOf('async function prepareCanonicalQrisSettlement('));
    expect(prepare.indexOf('QRIS_SOURCE_NET_MISMATCH')).toBeLessThan(prepare.indexOf('const journalResult = await client.query'));
    expect(prepare.indexOf('QRIS_CANONICAL_MDR_POLICY_MISMATCH')).toBeLessThan(prepare.indexOf('select sport_center.create_settlement_journal_draft')); 
  });
});

[executed on device: srv1792369 (0891e23a-6a6b-4f8c-a16a-962e888e2014)]