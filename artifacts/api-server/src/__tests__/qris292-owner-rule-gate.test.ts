import {describe,it,expect} from "vitest";
import {assertIssue292OwnerRuleParity} from "../lib/reconciliation/issue292OwnerRuleGate";

const valid=[
  {settlement_date:"2026-11-04",active_count:1,expected_count:1},
  {settlement_date:"2026-11-05",active_count:1,expected_count:1},
];
describe("Issue #292 owner rule parity before financial reversal",()=>{
  it("accepts exactly one historical 0.7% owner config on both days",async()=>{
    const queries:string[]=[];
    await expect(assertIssue292OwnerRuleParity({query:async(sql)=>{
      queries.push(sql);return {rows:valid};
    }})).resolves.toBeUndefined();
    expect(queries[0]).toContain("c.mdr_rate=0.007");
    expect(queries[0]).toContain("c.source='OWNER_APPROVED'");
    expect(queries[0]).toContain("2026-11-04");
    expect(queries[0]).toContain("2026-11-05");
  });
  it("rejects existing DEV 0.3% or wrong rule, even if present",async()=>{
    await expect(assertIssue292OwnerRuleParity({query:async()=>({
      rows:[{...valid[0],expected_count:0},{...valid[1],expected_count:0}],
    })})).rejects.toThrow("ISSUE292_OWNER_RULE_NOT_PARITY");
  });
  it("rejects overlapping active rules, missing dates and partial parity",async()=>{
    for(const rows of [
      [{...valid[0],active_count:2},valid[1]],
      [valid[0],{...valid[1],expected_count:0}],
      [valid[0]],
    ]){
      await expect(assertIssue292OwnerRuleParity({query:async()=>({rows})}))
        .rejects.toThrow("ISSUE292_OWNER_RULE_NOT_PARITY");
    }
  });
});
