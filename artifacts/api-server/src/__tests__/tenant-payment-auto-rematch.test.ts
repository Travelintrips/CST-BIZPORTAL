import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const worker = readFileSync(
  fileURLToPath(new URL("../lib/tenantPaymentAutoRematchWorker.ts", import.meta.url)),
  "utf8",
);
const index = readFileSync(
  fileURLToPath(new URL("../index.ts", import.meta.url)),
  "utf8",
);

describe("tenant payment auto rematch", () => {
  it("rechecks only canonical unmatched rule rows", () => {
    expect(worker).toContain("review_code = 'RULE_NO_CANONICAL_CANDIDATE'");
    expect(worker).toContain("candidate_source = 'public.tenant_payments'");
    expect(worker).toContain("abs(tp.amount::numeric - $2::numeric) < 0.01");
    expect(worker).toContain("= $3::date");
  });

  it("does not auto approve and preserves ambiguity", () => {
    expect(worker).toContain("'candidate', 'public.tenant_payments'");
    expect(worker).toContain("MULTIPLE_CANDIDATES");
    expect(worker).not.toContain("status = 'approved'");
  });

  it("starts the worker with the api server", () => {
    expect(index).toContain("startTenantPaymentAutoRematchWorker();");
  });
});
