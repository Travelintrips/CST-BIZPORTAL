import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const routesIndex = readFileSync(resolve(process.cwd(), "src/routes/index.ts"), "utf8");
const fleetRoute = readFileSync(resolve(process.cwd(), "src/routes/fleet-intelligence.ts"), "utf8");

describe("standalone fleet intelligence contract", () => {
  it("mounts fleet intelligence under the production API router", () => {
    expect(routesIndex).toContain('import fleetIntelligenceRouter from "./fleet-intelligence"');
    expect(routesIndex).toContain('router.use("/logistics/fleet", fleetIntelligenceRouter)');
  });

  it("protects all fleet endpoints with standalone admin auth", () => {
    expect(fleetRoute).toContain("authenticateAdmin(req as AdminRequest");
  });

  it("provides the dashboard and outstanding endpoints used by the live Fleet UI", () => {
    expect(fleetRoute).toContain('router.get("/dashboard"');
    expect(fleetRoute).toContain('router.get("/outstanding"');
    expect(fleetRoute).toContain('router.post("/outstanding/repair"');
    expect(fleetRoute).toContain('router.post("/outstanding/snapshot/preview"');
    expect(fleetRoute).toContain('router.post("/outstanding/snapshot/confirm"');
  });

  it("keeps GoCar driver master classification rules explicit", () => {
    expect(fleetRoute).toContain("const COMPANY_UNIT_RENTAL_FEE_MIN = 300_000");
    expect(fleetRoute).toContain('applicatorStatus === "fired"');
    expect(fleetRoute).toContain('applicatorStatus === "resign"');
    expect(fleetRoute).toContain('vehicleOwnership');
    expect(fleetRoute).toContain("full_name");
    expect(fleetRoute).toContain("license_number");
  });

  it("restores the operational Fleet surfaces used by BizPortal pages", () => {
    for (const route of [
      'router.get("/transactions"',
      'router.get("/drivers"',
      'router.put("/drivers/:id"',
      'router.get("/drivers/:extId/detail"',
      'router.get("/vehicles"',
      'router.post("/vehicles"',
      'router.get("/analytics"',
      'router.get("/alerts"',
      'router.get("/ledger"',
      'router.get("/outstanding/macet"',
      'router.get("/system-overview"',
      'router.get("/executive-summary"',
      'router.get("/settings"',
      'router.get("/cash-payments"',
      'router.post("/cash-payments"',
    ]) {
      expect(fleetRoute).toContain(route);
    }
  });
});
