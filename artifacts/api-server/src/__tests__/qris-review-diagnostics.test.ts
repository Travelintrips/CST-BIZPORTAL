import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const routeSource = readFileSync(
  resolve(process.cwd(), "src/routes/bank-reconciliation.ts"),
  "utf8",
);
const diagnosticSource = readFileSync(
  resolve(process.cwd(), "src/lib/reconciliation/qrisReviewDiagnostics.ts"),
  "utf8",
);

describe("QRIS historical review diagnostics", () => {
  it("hydrates review diagnostics on mutation list and detail responses", () => {
    expect(routeSource).toContain("hydrateQrisReviewDiagnostics(rows)");
    expect(routeSource).toContain(
      "hydrateQrisReviewDiagnostics(result.rows as MutationCandidateRow[])",
    );
  });

  it("keeps historical snapshots read-only and outside canonical approval authority", () => {
    expect(diagnosticSource).toContain("public.qris_mutation_batch_candidates");
    expect(diagnosticSource).toContain("candidate_auto_matched");
    expect(diagnosticSource).toContain("candidate_review");
    expect(diagnosticSource).not.toMatch(/\b(insert|update|delete)\s+(into|public\.qris_mutation_batch_candidates|from)/i);
    expect(diagnosticSource).toContain("current_evidence_valid");
    expect(diagnosticSource).toContain("diagnostic_amount_difference");
  });
});
