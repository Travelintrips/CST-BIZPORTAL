import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(process.cwd(), "src/routes/bank-reconciliation.ts"),
  "utf8",
);

describe("bank reconciliation production error diagnostics", () => {
  it("emits sanitized read-status and latency messages for failed/slow requests", () => {
    expect(source).toContain('router.use("/bank-reconciliation", (req, res, next) => {');
    expect(source).toContain('res.once("finish"');
    expect(source).toContain('res.statusCode < 400 && elapsedMs < 2_500');
    expect(source).toContain('const routePath = req.originalUrl.split("?", 1)[0]');
    expect(source).toContain('BankRecon read status=${res.statusCode} route=${routeLabel} duration_ms=${elapsedMs}');
  });

  it("avoids recording request parameters or private transaction attributes", () => {
    const diagnostic = source.slice(
      source.indexOf("// Hostinger's runtime log viewer retains"),
      source.indexOf('router.use("/bank-reconciliation", async (req, res, next) => {'),
    );
    expect(diagnostic).not.toContain("req.headers.cookie");
    expect(diagnostic).not.toContain("req.query.");
    expect(diagnostic).not.toContain("getProductionSession(");
    expect(diagnostic).not.toContain("account_number");
    expect(diagnostic).not.toContain("req.body");
    expect(diagnostic).not.toContain("routePath +");
  });

  it("keeps the full authentication guard after diagnostics", () => {
    expect(source).toContain('router.use("/bank-reconciliation", async (req, res, next) => {');
    expect(source).toContain("const actor = await getApprovalActor(req)");
    expect(source).toContain('res.status(401).json({ error: "Unauthorized" })');
    expect(source).toContain('res.setHeader("Cache-Control", "private, no-store")');
  });
});
