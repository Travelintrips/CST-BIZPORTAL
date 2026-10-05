import { describe, expect, it } from "vitest";
import { evaluateReconRules, type ReconRule } from "../lib/reconciliation/reconRuleEngine.js";

const wifiRule: ReconRule = {
  id: 177,
  companyId: 1,
  name: "Wifi kantor",
  description: null,
  priority: 50,
  isActive: true,
  direction: null,
  bankAccountId: 1,
  conditionType: "single",
  conditionField: "description",
  conditionOperator: "contains",
  conditionValue: "Wifi kantor",
  conditionsJson: [
    { field: "description", operator: "contains", value: "Wifi kantor", negate: false },
    { field: "description", operator: "contains", value: "MyTelkomsel App", negate: false },
  ],
  logic: "OR",
  specificity: 2,
  amountTolerance: 0,
  referenceAmount: null,
  candidateRequirement: "not_required",
  requiresDocumentUpload: false,
  taxType: "none",
  aiClassificationRuleId: null,
  targetType: "expense",
  targetId: null,
  targetCoaCode: "5-2080-CST",
  confidenceScore: 80,
  stopProcessing: false,
  matchCount: 0,
  lastMatchedAt: null,
  createdBy: null,
  createdAt: "",
  updatedAt: "",
};

describe("Rule AI OR condition for Kas Besar SC", () => {
  for (const description of [
    "Transfer ke SEABANK - Wifi kantor",
    "Pembayaran QRIS | MyTelkomsel App G090012302",
  ]) {
    it(`matches ${description}`, () => {
      const result = evaluateReconRules([wifiRule], {
        description,
        amount: 111000,
        direction: "OUT",
        bankAccountId: 1,
        companyId: 1,
      });
      expect(result.matched).toBe(true);
      expect(result.ruleId).toBe(177);
      expect(result.targetCoaCode).toBe("5-2080-CST");
    });
  }
});
