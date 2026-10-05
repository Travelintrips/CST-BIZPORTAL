import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const routesIndex = readFileSync(resolve(process.cwd(), "src/routes/index.ts"), "utf8");
const integration = readFileSync(resolve(process.cwd(), "src/routes/fleet-finance-integration.ts"), "utf8");

describe("Fleet Central Finance service integration", () => {
  it("is mounted under a dedicated internal integration path", () => {
    expect(routesIndex).toContain('import fleetFinanceIntegrationRouter from "./fleet-finance-integration"');
    expect(routesIndex).toContain('router.use("/integrations/fleet", fleetFinanceIntegrationRouter)');
  });

  it("fails closed unless a dedicated service token is configured", () => {
    expect(integration).toContain("FLEET_FINANCE_SERVICE_TOKEN");
    expect(integration).toContain('res.status(503).json({ error: "Fleet Finance integration belum dikonfigurasi." })');
    expect(integration).toContain("timingSafeEqual");
    expect(integration).toContain('res.status(401).json({ error: "Unauthorized" })');
  });

  it("requires idempotency for accounting writes", () => {
    expect(integration).toContain("Idempotency-Key wajib 8-200 karakter");
    expect(integration).toContain('router.post("/cash-payments"');
    expect(integration).toContain('router.post("/cash-payments/reverse"');
    expect(integration).toContain("source='fleet_cash_payment'");
    expect(integration).toContain("source='reversal'");
  });

  it("keeps the accounting settings source inside Central Finance", () => {
    expect(integration).toContain('router.get("/companies/:companyId/accounting-settings"');
    expect(integration).toContain('router.put("/companies/:companyId/accounting-settings"');
    expect(integration).toContain("public.accounting_settings");
    expect(integration).toContain("public.chart_of_accounts");
    expect(integration).toContain("public.accounting_journals");
  });
});
