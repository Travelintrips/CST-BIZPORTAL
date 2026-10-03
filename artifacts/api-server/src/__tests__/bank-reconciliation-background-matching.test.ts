import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../routes/bank-reconciliation.ts", import.meta.url)),
  "utf8",
);

describe("bank reconciliation background matching", () => {
  it("queues bulk matching instead of keeping the HTTP request open", () => {
    const start = source.indexOf('router.post("/bank-reconciliation/run-matching"');
    const end = source.indexOf("type SourceReceiptJournal", start);
    const body = source.slice(start, end);

    expect(body).toContain("const isBulkRun = ids.length === 0");
    expect(body).toContain("res.status(202).json");
    expect(body).toContain("queued: true");
  });

  it("uses bounded workers and exposes background status", () => {
    expect(source).toContain("const workerCount = Math.min(4, rows.length)");
    expect(source).toContain("Promise.all(Array.from({ length: workerCount }, () => worker()))");
    expect(source).toContain("matchingJobsByCompany.get(jobKey)");
    expect(source).toContain("loadPersistedMatchingJobState(jobKey)");
    expect(source).toContain("claimMatchingJob(jobKey, initialJobState)");
    expect(source).toContain("touchMatchingJobState(jobKey, nextState)");
    expect(source).toContain("already_running: true");
    expect(source).toContain('X-CST-Bank-Recon-Revision');
    expect(source).toContain('private, no-store, no-cache, must-revalidate');
    expect(source).toContain('status: "failed"');
  });
});
