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

  it("binds QRIS diagnostic filters and limit as PostgreSQL parameters", () => {
    expect(diagnosticSource).toContain('qris.company_id = $' + '${values.length}');
    expect(diagnosticSource).toContain('qris.mutation_id = any($' + '${values.length}' + '::int[])');
    expect(diagnosticSource).toContain('limit $' + '${values.length}');
  });
  it("keeps historical snapshots read-only and outside canonical approval authority", () => {
    expect(diagnosticSource).toContain("public.qris_mutation_batch_candidates");
    expect(diagnosticSource).toContain("candidate_auto_matched");
    expect(diagnosticSource).toContain("candidate_review");
    expect(diagnosticSource).not.toMatch(/\b(insert|update|delete)\s+(into|public\.qris_mutation_batch_candidates|from)/i);
    expect(diagnosticSource).toContain("current_evidence_valid: false");
    expect(diagnosticSource).toContain('candidate_source: "historical_qris_review_snapshot"');
    expect(diagnosticSource).toContain("diagnostic_amount_difference");
    expect(routeSource).toContain("listQrisReviewDiagnostics({ companyId, limit })");
    expect(routeSource).toContain("candidates: reviewDiagnostics");
  });
});
