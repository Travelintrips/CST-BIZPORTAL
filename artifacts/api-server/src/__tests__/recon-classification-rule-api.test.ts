import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const api = readFileSync(
  fileURLToPath(new URL("../routes/recon-classification.ts", import.meta.url)),
  "utf8",
);
const idx = readFileSync(
  fileURLToPath(new URL("../routes/index.ts", import.meta.url)),
  "utf8",
);

describe("Rule AI config API", () => {
  it("reads canonical recon_rules by company and reconciliation account", () => {
    expect(api).toContain("from public.recon_rules");
    expect(api).toContain("where r.company_id = $1");
    expect(api).toContain("and r.bank_account_id = $2");
    expect(api).toContain("company_id dan bank_account_id Akun Rekonsiliasi wajib");
  });

  it("validates that the Rule AI account is an active reconciliation account", () => {
    expect(api).toContain("from public.bank_sheet_configs config");
    expect(api).toContain("config.bank_account_id = $2");
    expect(api).toContain("config.is_active = true");
    expect(api).toContain("Akun Rekonsiliasi tidak valid atau tidak aktif");
  });

  it("exposes company-scoped COA options for the AI rule editor", () => {
    expect(api).toContain('router.get("/recon-classification/coa-options"');
    expect(api).toContain("from public.chart_of_accounts c");
    expect(api).toContain("where c.company_id=$1 or c.company_id is null");
    expect(api).toContain('c.company_id as "companyId"');
    expect(api).toContain('c.normal_balance as "normalBalance"');
    expect(api).toContain("c.is_postable");
  });

  it("keeps rules pinned to their original reconciliation account", () => {
    expect(api).toContain("Rule AI tidak boleh dipindahkan ke Akun Rekonsiliasi lain");
    expect(api).toContain("and bank_account_id=$23");
  });

  it("uses edited action flow before stale target_type metadata", () => {
    expect(api).toContain("const targetTypeForInput");
    expect(api).toContain('switch (String(body?.action_flow ?? "").trim().toUpperCase())');
    expect(api).toContain('case "INTERNAL_TRANSFER"');
    expect(api).toContain('return "internal_transfer"');
    expect(api.indexOf('switch (String(body?.action_flow ?? "").trim().toUpperCase())'))
      .toBeLessThan(api.indexOf('const explicit = String(body?.target_type ?? "").trim().toLowerCase()'));
    expect(api).toContain("targetTypeForInput(b)");
    expect(api).toContain("action_flow: r.action_flow ?? actionFlowForTargetType(r.target_type)");
  });

  it("supports CRUD on canonical rules", () => {
    for (const x of [
      'router.get("/recon-classification/ai-rules"',
      'router.post("/recon-classification/ai-rules"',
      'router.patch("/recon-classification/ai-rules/:id"',
      'router.delete("/recon-classification/ai-rules/:id"',
      'router.post("/recon-classification/ai-rules/:id/activate"',
    ]) {
      expect(api).toContain(x);
    }
  });

  it("is mounted before fallback", () => {
    expect(idx).toContain("router.use(reconClassificationRouter)");
    expect(idx.indexOf("router.use(reconClassificationRouter)"))
      .toBeLessThan(idx.indexOf("BIZPORTAL_LOCAL_ENDPOINT_NOT_FOUND"));
  });
});
