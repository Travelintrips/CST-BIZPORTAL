import {describe,it,expect} from "vitest";
import {kasbonReviewMatchesReservations} from "./payroll-kasbon-hr-review-guard";
const item=(amount="500.00")=>({id:4,employee_id:51,kasbon_deduction:amount});
const hold=(o:Record<string,unknown>={})=>({
 payrollItemId:4,employeeId:51,amount:"500.00",heldBalance:"1500.00",currentBalance:"1500.00",
 advanceStatus:"partial",advanceLifecycle:"partially_settled",
 advanceApprovedAt:"2026-10-01T09:00:00Z",advanceApprovedBy:"super-admin",
 advanceDisbursedAt:"2026-10-02T09:00:00Z",advanceDisbursedBy:"finance",
 advanceAccountingEntryId:9001,advancePostingStatus:"posted",advanceVoidedAt:null,
 state:"prepared",...o,
});
describe("PROD-gated Payroll kasbon reservation integrity",()=>{
 it("accepts matching prepared holds without settling the advance",()=>{
  expect(kasbonReviewMatchesReservations([item()],[hold()])).toBe(true);
 });
 it("rejects positive deduction without reservation",()=>{
  expect(kasbonReviewMatchesReservations([item()],[])).toBe(false);
 });
 it("rejects mismatched amount and over-allocation",()=>{
  expect(kasbonReviewMatchesReservations([item()],[hold({amount:"499.99"})])).toBe(false);
  expect(kasbonReviewMatchesReservations([item()],[hold(),hold()])).toBe(false);
 });
 it("rejects changed canonical balance, wrong employee, settled advance or non-prepared status",()=>{
  expect(kasbonReviewMatchesReservations([item()],[hold({currentBalance:"1400.00"})])).toBe(false);
  expect(kasbonReviewMatchesReservations([item()],[hold({employeeId:52})])).toBe(false);
  expect(kasbonReviewMatchesReservations([item()],[hold({state:"confirmed"})])).toBe(false);
  expect(kasbonReviewMatchesReservations([item()],[hold({advanceStatus:"repaid"})])).toBe(false);
 });
 it("rejects a reservation when the source kasbon lacks approval, disbursement or posted journal evidence",()=>{
  expect(kasbonReviewMatchesReservations([item()],[hold({advanceApprovedAt:null})])).toBe(false);
  expect(kasbonReviewMatchesReservations([item()],[hold({advanceApprovedBy:" "})])).toBe(false);
  expect(kasbonReviewMatchesReservations([item()],[hold({advanceDisbursedAt:null})])).toBe(false);
  expect(kasbonReviewMatchesReservations([item()],[hold({advanceDisbursedBy:null})])).toBe(false);
  expect(kasbonReviewMatchesReservations([item()],[hold({advanceAccountingEntryId:null})])).toBe(false);
  expect(kasbonReviewMatchesReservations([item()],[hold({advancePostingStatus:"PENDING"})])).toBe(false);
  expect(kasbonReviewMatchesReservations([item()],[hold({advanceVoidedAt:"2026-11-01"})])).toBe(false);
 });
 it("rejects orphan holds or malformed money and preserves zero-advance review",()=>{
  expect(kasbonReviewMatchesReservations([item("0.00")],[])).toBe(true);
  expect(kasbonReviewMatchesReservations([item("0.00")],[hold()])).toBe(false);
  expect(kasbonReviewMatchesReservations([item("500.00")],[hold({amount:"NaN"})])).toBe(false);
 });
});
