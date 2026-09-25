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
});
