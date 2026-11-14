import { describe, expect, it } from "vitest";
import { isPayrollProdApprover } from "./payroll-prod-approver";

const cstOwner = {role:"owner",email:"admcst001@gmail.com",companyId:1};
describe("narrow CST Owner equivalence for gated PROD Payroll", () => {
  it("accepts the existing active authenticated CST Owner identity only in CST scope", () => {
    expect(isPayrollProdApprover(cstOwner,1)).toBe(true);
    expect(isPayrollProdApprover({...cstOwner,email:" ADMCST001@GMAIL.COM "},1)).toBe(true);
  });
  it("keeps the original Super Admin permission; company authorization remains upstream", () => {
    expect(isPayrollProdApprover({role:"super_admin",email:"super@example.test",companyId:5},5)).toBe(true);
  });
  it("rejects unrelated Owners, other companies, missing scopes, and other roles", () => {
    expect(isPayrollProdApprover({...cstOwner,email:"other@example.test"},1)).toBe(false);
    expect(isPayrollProdApprover({...cstOwner,companyId:5},1)).toBe(false);
    expect(isPayrollProdApprover(cstOwner,5)).toBe(false);
    expect(isPayrollProdApprover(cstOwner,null)).toBe(false);
    expect(isPayrollProdApprover({...cstOwner,role:"admin"},1)).toBe(false);
    expect(isPayrollProdApprover({...cstOwner,role:"finance"},1)).toBe(false);
    expect(isPayrollProdApprover(null,1)).toBe(false);
  });
});
