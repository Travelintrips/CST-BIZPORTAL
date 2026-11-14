import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateReconRules, type ReconRule } from "../lib/reconciliation/reconRuleEngine.js";

const source = readFileSync(fileURLToPath(new URL("../routes/recon-classification.ts", import.meta.url)), "utf8");
const previewRoute = source.slice(source.indexOf('router.post("/recon-classification/ai-rules/preview"'));
const draft = (overrides: Partial<ReconRule> = {}): ReconRule => ({
  id: -1, companyId: 1, name: "Biaya Admin Top Up E-Wallet",
  description: null, priority: 50, isActive: true, direction: "OUT",
  bankAccountId: 1, conditionType: "COMPOUND",
  conditionField: "description", conditionOperator: "contains",
  conditionValue: "Biaya Top Up E-Wallet",
  conditionsJson: [{ field: "description", operator: "contains", value: "Biaya Top Up E-Wallet" }],
  logic: "AND", specificity: 1, amountTolerance: 0, referenceAmount: null,
  candidateRequirement: "not_required", requiresDocumentUpload: false,
  taxType: "none", targetType: "expense", targetId: null,
  targetCoaCode: "5-3010-CST", confidenceScore: 80,
  stopProcessing: true, matchCount: 0, lastMatchedAt: null,
  createdBy: null, createdAt: "", updatedAt: "", ...overrides,
});
const mutation = (description: string, amount = 1000, direction: "IN" | "OUT" = "OUT", bankAccountId = 1) =>
  ({ description, amount, direction, bankAccountId, companyId: 1 });

describe("Kas Besar CST — read-only Rule AI preview", () => {
  it("uses the shared operational matcher rather than a fixed false result", () => {
    expect(previewRoute).toContain("evaluateReconRules([draft]");
    expect(previewRoute).toContain('previewScope: "draft_only"');
    expect(previewRoute).not.toContain("matched: false,");
    expect(previewRoute).not.toMatch(/\b(insert into|update public|delete from|\/approve|\/post)\b/i);
  });
  it("matches the unsaved e-wallet fee draft, even without a fixed reference amount", () => {
    const result = evaluateReconRules([draft()], mutation("Biaya Top Up E-Wallet GoPay"));
    expect(result).toMatchObject({ matched: true, ruleId: -1, targetCoaCode: "5-3010-CST", confidence: 80 });
  });
  it("does not match phone-credit purchases or incoming mutations", () => {
    expect(evaluateReconRules([draft()], mutation("Pembelian Pulsa Telkomsel", 1500)).matched).toBe(false);
    expect(evaluateReconRules([draft()], mutation("Biaya Top Up E-Wallet GoPay", 1000, "IN")).matched).toBe(false);
  });
  it("respects reference amount and bank account scope", () => {
    expect(evaluateReconRules([draft({ referenceAmount: 1500 })], mutation("Biaya Top Up E-Wallet DANA", 1000)).matched).toBe(false);
    expect(evaluateReconRules([draft()], mutation("Biaya Top Up E-Wallet GoPay", 1000, "OUT", 2)).matched).toBe(false);
  });
  it("enforces evidence gate without writing audit or journal rows", () => {
    expect(evaluateReconRules([draft({ requiresDocumentUpload: true })], mutation("Biaya Top Up E-Wallet DANA")).matched).toBe(false);
  });
});
