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
    expect(fleetRoute).toContain("d.status AS driver_status");
    expect(fleetRoute).toContain("d.applicator_status");
    expect(fleetRoute).toContain('router.post("/outstanding/repair"');
    expect(fleetRoute).toContain('router.post("/outstanding/snapshot/preview"');
    expect(fleetRoute).toContain("full_name=$3");
    expect(fleetRoute).toContain("company_id=$2::text");
    expect(fleetRoute).toContain('router.post("/outstanding/snapshot/confirm"');
  });

  it("keeps GoCar driver master classification rules explicit", () => {
    expect(fleetRoute).toContain("const COMPANY_UNIT_RENTAL_FEE_MIN = 300_000");
    expect(fleetRoute).toContain('applicatorStatus === "fired"');
    expect(fleetRoute).toContain('applicatorStatus === "resign"');
    expect(fleetRoute).toContain('vehicleOwnership');
    expect(fleetRoute).toContain("full_name");
    expect(fleetRoute).toContain("license_number");
    expect(fleetRoute).toContain("full_name AS name");
    expect(fleetRoute).toContain("Synced from GoCar Drivers export; ownership=");
    expect(fleetRoute).toContain("public.fleet_vehicles");
  });

  it("restores expenses, transaction upload, pipeline, DLQ and reconciliation APIs", () => {
    for (const route of [
      'router.get("/expenses"',
      'router.post("/expenses"',
      'router.get("/expenses/budgets"',
      'router.post("/expenses/budgets"',
      'router.post("/reports/preview"',
      'router.post("/reports/upload"',
      'router.get("/reports/:id/progress"',
      'router.get("/pipeline/monitor"',
      'router.get("/pipeline/export-csv"',
      'router.get("/pipeline/dlq"',
      'router.post("/pipeline/reconcile"',
      'router.get("/row-diff/reports"',
      'router.get("/row-diff"',
      'router.get("/accounting/journals"',
      'router.post("/accounting/journals/generate"',
      'router.put("/accounting/journals/:id/approve"',
      'router.put("/accounting/journals/:id/post"',
    ]) expect(fleetRoute).toContain(route);
    expect(fleetRoute).toContain("Posting Fleet ke Central Finance belum diaktifkan");
    expect(fleetRoute).not.toContain("insert into public.accounting_entries");
  });

  it("posts Fleet cash payments to Central Finance idempotently", () => {
    expect(fleetRoute).toContain("fleet_cash_account_id");
    expect(fleetRoute).toContain("fleet_driver_receivable_account_id");
    expect(fleetRoute).toContain("source='fleet_cash_payment'");
    expect(fleetRoute).toContain("source_module");
    expect(fleetRoute).toContain("fleet_intelligence");
    expect(fleetRoute).toContain("accounting_entry_lines");
    expect(fleetRoute).toContain("status='posted'");
    expect(fleetRoute).toContain("reverseFleetCashAccounting");
    expect(fleetRoute).toContain("source='reversal'");
    expect(fleetRoute).not.toContain("accountingPosted:false");
  });

  it("restores WA reminders only for active drivers with outstanding", () => {
    expect(fleetRoute).toContain('router.post("/outstanding/wa-reminder"');
    expect(fleetRoute).toContain('router.post("/outstanding/wa-blast"');
    expect(fleetRoute).toContain('router.post("/outstanding/:id/wa"');
    expect(fleetRoute).toContain('router.get("/outstanding/wa-logs"');
    expect(fleetRoute).toContain('router.get("/outstanding/auto-blast-settings"');
    expect(fleetRoute).toContain('router.put("/outstanding/auto-blast-settings"');
    expect(fleetRoute).toContain("sendFleetOutstandingReminders");
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
