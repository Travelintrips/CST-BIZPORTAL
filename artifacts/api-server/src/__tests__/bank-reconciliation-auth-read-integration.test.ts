import express from "express";
import http, { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const poolQuery = vi.hoisted(() => vi.fn(async (statement: string) => {
  if (statement.toLowerCase().includes("count(*)::text as total")) {
    return { rows: [{ total: "0" }] };
  }
  return { rows: [] };
}));
vi.mock("@workspace/db", () => ({ pool: { query: poolQuery } }));
vi.mock("../routes/dev-auth", () => ({
  isDevelopmentEnvironment: () => true,
  getDevSession: (request: { headers: Record<string, string | undefined> }) =>
    request.headers["x-test-role"] === "admin"
      ? { email: "authorized-test@example.invalid", role: "admin", companyId: 1 }
      : null,
  getProductionSession: () => null,
  getProductionUser: async () => null,
}));

let server: Server;
let port: number;

function get(path: string, authenticated = false): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: "127.0.0.1",
      port,
      path,
      headers: authenticated ? { "x-test-role": "admin" } : {},
    }, (response) => {
      const buffers: Buffer[] = [];
      response.on("data", (part: Buffer) => buffers.push(part));
      response.on("end", () => resolve({
        status: response.statusCode ?? 500,
        body: Buffer.concat(buffers).toString("utf8"),
      }));
    });
    request.on("error", reject);
  });
}

beforeAll(async () => {
  const { default: router } = await import("../routes/bank-reconciliation");
  const app = express();
  app.use("/api", router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()));
});

describe("authenticated bank reconciliation read integration", () => {
  it("does not return bank, company, or QRIS data without a session", async () => {
    for (const path of [
      "/api/bank-reconciliation/mutations?compact=1",
      "/api/bank-reconciliation/summary",
      "/api/bank-reconciliation/ready-approval-mutations",
      "/api/bank-reconciliation/sheet-configs",
      "/api/bank-reconciliation/qris-candidates",
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(401);
      expect(response.body).not.toContain("mutations");
    }
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("rejects a logged-in user attempting to query a different company", async () => {
    for (const path of [
      "/api/bank-reconciliation/mutations?company_id=2",
      "/api/bank-reconciliation/summary?company_id=2",
      "/api/bank-reconciliation/sheet-configs?company_id=2",
      "/api/bank-reconciliation/qris-candidates?companyId=2",
      "/api/bank-reconciliation/ready-approval-mutations?company_id=2",
    ]) {
      expect((await get(path, true)).status, path).toBe(403);
    }
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("uses an authenticated server-side work queue that never includes final statuses", async () => {
    poolQuery.mockClear();
    const open = await get("/api/bank-reconciliation/mutations?company_id=1&status=attention&compact=1&limit=20", true);
    expect(open.status).toBe(200);
    const sql = poolQuery.mock.calls.map(([statement]) => statement);
    expect(sql).toHaveLength(2); // paginated count + compact 20-row list
    expect(sql[0]).toContain("bm.company_id = $1");
    expect(sql[0]).toContain("bm.status in ('unmatched', 'matched', 'manual_review', 'duplicate_need_review', 'approved_pending_posting')");
    expect(sql[1]).toContain("case bm.status");
    expect(sql[1]).toContain("when 'approved_pending_posting' then 0");
    expect(sql[1]).toContain("limit $2");
    expect(sql[1]).toContain("offset $3");
    expect(sql[1]).not.toContain("hydrateMutationCandidateDetails");

    poolQuery.mockClear();
    const closed = await get("/api/bank-reconciliation/mutations?company_id=1&status=completed&compact=1", true);
    expect(closed.status).toBe(200);
    expect(poolQuery.mock.calls[0][0]).toContain("bm.status in ('posted', 'approved')");

    poolQuery.mockClear();
    expect((await get("/api/bank-reconciliation/mutations?status=attention&company_id=2", true)).status).toBe(403);
    expect(poolQuery).not.toHaveBeenCalled();
    expect((await get("/api/bank-reconciliation/mutations?status=unrecognized", true)).status).toBe(400);
  });

  it("preserves authenticated mutation, summary and readiness access for the user's company", async () => {
    expect((await get("/api/bank-reconciliation/mutations?compact=1", true)).status).toBe(200);
    expect((await get("/api/bank-reconciliation/summary", true)).status).toBe(200);
    expect((await get("/api/bank-reconciliation/ready-approval-mutations", true)).status).toBe(200);
    expect(poolQuery).toHaveBeenCalled();
    const calls = poolQuery.mock.calls;
    expect(calls.some(([sql]) => sql.includes("bm.company_id = $1"))).toBe(true);
    expect(calls.some(([sql]) => sql.includes("mutationListCompactColumns"))).toBe(false);
  });
});
