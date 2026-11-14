import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync(new URL("../routes/customer-ar-match-preview.ts", import.meta.url), "utf8");
describe("Customer AR preview is DEV only and read-only", () => {
  it("returns 404 outside development before querying any invoices or mutations", () => {
    const begin = route.indexOf('router.get("/sales/customer-invoices/auto-match-preview"');
    expect(begin).toBeGreaterThanOrEqual(0);
    const guard = route.slice(begin, begin + 300);
    expect(guard).toContain("if (!isDevelopmentEnvironment())");
    expect(guard).toContain("response.status(404)");
  });
  it("never adds a second payment or Accounting write endpoint", () => {
    expect(route).not.toMatch(/router\.(post|patch|put|delete)\(/);
    expect(route).toContain('autoApproveEnabled: false');
    expect(route).toContain('autoPostEnabled: false');
  });
});
