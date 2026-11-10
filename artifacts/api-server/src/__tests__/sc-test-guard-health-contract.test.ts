import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("SC test import guard runtime marker", () => {
  it("exposes guard marker only alongside the actual importer skip condition", () => {
    const health = readFileSync(resolve(process.cwd(), "src/routes/health.ts"), "utf8");
    const importer = readFileSync(resolve(process.cwd(), "src/lib/bank-sheet-sync.ts"), "utf8");
    expect(health).toContain('router.get("/health/sc-test-guard"');
    expect(health).toContain('guard: "sc-test-only-v1"');
    expect(importer).toContain('reconStatus === "SC_TEST_ONLY"');
    expect(importer).toContain('/^SC-TEST-(?:IN|OUT):[ ]/');
  });
});
