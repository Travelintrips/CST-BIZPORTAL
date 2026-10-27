import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const api = readFileSync(fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)), "utf8");
const ui = readFileSync(
  fileURLToPath(new URL("../../../bizportal/src/pages/accounting/bank-reconciliation.tsx", import.meta.url)),
  "utf8",
);

describe("bank reconciliation read security and performance contract", () => {
  it("authenticates every reconciliation route before any read can run", () => {
    const guard = api.indexOf('router.use("/bank-reconciliation", async (req, res, next)');
    const firstRoute = api.indexOf('router.get("/bank-reconciliation/');
    expect(guard).toBeGreaterThan(0);
    expect(firstRoute).toBeGreaterThan(guard);
    const middleware = api.slice(guard, api.indexOf("function normalizeMatchText", guard));
    expect(middleware).toContain("getApprovalActor(req)");
    expect(middleware).toContain("res.status(401)");
    expect(middleware).toContain('Cache-Control", "private, no-store"');
  });

  it("cannot widen a company-scoped user's bank read using query parameters", () => {
    const filters = api.slice(
      api.indexOf("function buildMutationFilters("),
      api.indexOf("const mutationListColumns ="),
    );
    expect(filters).toContain('throw new Error("FORBIDDEN_COMPANY")');
    expect(filters).toContain("actor?.companyId ?? companyId");
    expect(api).toContain("res.status(403).json({ error: \"Company context tidak sesuai\" })");
  });

  it("keeps the detailed route and journal evidence separate from a compact list", () => {
    expect(api).toContain("const mutationListCompactColumns =");
    expect(api).toContain('const compact = queryString(req.query.compact) === "1"');
    expect(api).toContain("compact ? mutationListCompactColumns : mutationListColumns");
    expect(api).toContain("if (!compact)");
    expect(api).toContain("router.get(\"/bank-reconciliation/mutations/:mutationId\"");
    expect(ui).toContain('compact: "1"');
    expect(ui).toContain("openMutationDetail");
  });

  it("does not repeatedly fetch 1000 fully hydrated rows for readiness", () => {
    expect(api).toContain('"/bank-reconciliation/ready-approval-mutations"');
    expect(ui).toContain("/api/bank-reconciliation/ready-approval-mutations");
    expect(ui).not.toContain('new URLSearchParams({ status: "matched", limit: "1000", offset: "0" })');
  });

  it("defers optional QRIS audit/history reads and preserves post-action invalidation", () => {
    expect(ui).toContain("showQrisAuditList || showCanonicalSettlementQueue");
    expect(ui).toContain("qrisCompanyId != null && showQrisResetHistory");
    expect(ui).toContain('Tampilkan riwayat reset QRIS');
    expect(ui).toContain('qc.invalidateQueries({ queryKey: ["bank-reconciliation"] })');
    expect(ui).toContain('qc.invalidateQueries({ queryKey: ["bank-reconciliation-summary"] })');
  });
});
