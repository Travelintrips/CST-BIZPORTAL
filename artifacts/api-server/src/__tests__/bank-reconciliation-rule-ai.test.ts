import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const route=readFileSync(fileURLToPath(new URL('../routes/bank-reconciliation.ts',import.meta.url)),'utf8');
describe('standalone Rule AI wiring',()=>{
 it('loads active rules before fallback',()=>{expect(route).toContain('from public.recon_rules where company_id=$1 and is_active=true');expect(route.indexOf('evaluateReconRules(rules')).toBeLessThan(route.indexOf('const best = candidates[0]'));});
 it('persists explainability',()=>{expect(route).toContain("'public.recon_rules'");expect(route).toContain("engine:'bizportal-rule-ai'");expect(route).toContain("review_code='RULE_AI_MATCH'");});
 it('keeps candidate-required rules unmatched until a real candidate exists',()=>{expect(route).toContain("candidateRequirement==='required'&&!realCandidate");expect(route).toContain("status='unmatched',reconciliation_status='unmatched'");expect(route).toContain("review_code='RULE_CANDIDATE_REQUIRED'");expect(route).toContain("'RULE_CANDIDATE_REQUIRED_UNMATCHED'");});
 it('enforces document requirement',()=>{expect(route).toContain('ruleResult.documentRequired');expect(route).toContain("review_code='RULE_DOCUMENT_REQUIRED'");});
});
