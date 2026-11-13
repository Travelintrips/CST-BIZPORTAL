import { describe, expect, it } from "vitest";
import {
  inspectPostedUnlinkedBankCohorts,
  type ReconciliationReadClient,
} from "../lib/reconciliation/postedUnlinkedSettlementPreflight";

const five = [
  {id:834,amount:30000,mdr_amount:0,journal_count:1},
  {id:843,amount:30000,mdr_amount:0,journal_count:1},
  {id:853,amount:30000,mdr_amount:0,journal_count:1},
  {id:856,amount:300000,mdr_amount:2100,journal_count:1},
  {id:858,amount:300000,mdr_amount:2100,journal_count:1},
];
const four = [
  {id:859,amount:300000,mdr_amount:2100,journal_count:1},
  {id:860,amount:300000,mdr_amount:2100,journal_count:1},
  {id:861,amount:30000,mdr_amount:0,journal_count:1},
  {id:862,amount:300000,mdr_amount:2100,journal_count:1},
];
function fixture(change: {
  wrongBank?:boolean; wrongNet?:boolean; reversal?:boolean;
  foreignMembership?:boolean; lostPayment?:boolean;
}={}) {
  const queries:string[]=[];
  const client: ReconciliationReadClient = {
    async query(query, params=[]) {
      queries.push(query);
      if (query.includes("from sport_center.payment_settlement_batches b")) return {rows:[{
        id:5738,status:"posted",company_id:1,provider_code:"mandiri_direct",
        bank_account_id:"1640006707220",settlement_date:"2026-11-05",
        gross_amount:930000,mdr_amount:6300,net_amount:923700,
        settlement_journal_id:7207,bank_mutation_id:null,canonical_bank_mutation_id:null,
        journal_status:"posted",journal_type:"settlement",is_reversal:false,
        journal_batch_id:5738,
      }]};
      if (query.includes("sport_center.accounting_journal_lines")) return {rows:[
        {n:3,debits:930000,credits:930000},
      ]};
      if (query.includes("reversal_of_id=$1")) return {rows:change.reversal?[{id:8000}]:[]};
      if (query.includes("where settlement_id=$1 and item_status='active'")) return {rows:
        [856,859,860,861].map(payment_id=>({payment_id}))};
      if (query.includes("from public.bank_mutations m")) return {rows:[
        {id:434462,company_id:1,status:"unmatched",transaction_date:"2026-11-04",
         amount:685800,source_classification:"actual_bank_mutation",direction:"IN",
         journal_entry_id:null,approved_at:null,posted_at:null,
         account_company_id:1,account_number:change.wrongBank?"BAD":"1640006707220",is_active:true},
        {id:434464,company_id:1,status:"matched",transaction_date:"2026-11-05",
         amount:change.wrongNet?923701:923700,
         source_classification:"actual_bank_mutation",direction:"IN",
         journal_entry_id:null,approved_at:null,posted_at:null,
         account_company_id:1,account_number:"1640006707220",is_active:true},
      ]};
      if (query.includes("from sport_center.sport_payments p")) return {rows:
        String(params[3])==="2026-11-04" ?
          (change.lostPayment?five.slice(0,4):five) : four};
      if (query.includes("select payment_id,settlement_id from sport_center.payment_settlement_items")) {
        return {rows:[856,859,860,861].map(payment_id=>({
          payment_id,settlement_id:change.foreignMembership && payment_id===856?9999:5738,
        }))};
      }
      throw new Error("Unexpected SQL: "+query);
    }
  };
  return {client,queries};
}
describe("posted/unlinked canonical settlement correction preflight",()=>{
  it("finds both actual bank cohorts and never enables posting",async()=>{
    const f=fixture();
    const result=await inspectPostedUnlinkedBankCohorts(
      f.client,5738,[434462,434464],1,
    );
    expect(result.ok).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.postingPermitted).toBe(false);
    expect(result.originalPaymentIds).toEqual([856,859,860,861]);
    expect(result.cohorts.map(c=>[c.settlementDate,c.net,c.paymentIds]))
      .toEqual([
        ["2026-11-04",685800,[834,843,853,856,858]],
        ["2026-11-05",923700,[859,860,861,862]],
      ]);
    expect(f.queries.every(q=>!/\b(insert|update|delete|alter|drop|truncate)\s+/i.test(q)))
      .toBe(true);
  });
  it("rejects a mismatched actual receiving account",async()=>{
    const f=fixture({wrongBank:true});
    await expect(inspectPostedUnlinkedBankCohorts(
      f.client,5738,[434462,434464],1)).rejects.toThrow("bank identity");
  });
  it("rejects an invented net amount",async()=>{
    const f=fixture({wrongNet:true});
    await expect(inspectPostedUnlinkedBankCohorts(
      f.client,5738,[434462,434464],1)).rejects.toThrow("bank net");
  });
  it("rejects an already posted compensating journal",async()=>{
    const f=fixture({reversal:true});
    await expect(inspectPostedUnlinkedBankCohorts(
      f.client,5738,[434462,434464],1)).rejects.toThrow("posted reversal");
  });
  it("rejects cross-settlement active payment ownership",async()=>{
    const f=fixture({foreignMembership:true});
    await expect(inspectPostedUnlinkedBankCohorts(
      f.client,5738,[434462,434464],1)).rejects.toThrow("another batch");
  });
  it("rejects a missing member even if other evidence looks right",async()=>{
    const f=fixture({lostPayment:true});
    await expect(inspectPostedUnlinkedBankCohorts(
      f.client,5738,[434462,434464],1)).rejects.toThrow("bank net");
  });
});
