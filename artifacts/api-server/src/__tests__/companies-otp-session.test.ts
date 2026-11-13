import http from "node:http";
import express from "express";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  devSession: vi.fn(),
  signedSession: vi.fn(),
  productionUser: vi.fn(),
  dbQuery: vi.fn(),
}));
vi.mock("../routes/dev-auth", () => ({
  isDevelopmentEnvironment: () => true,
  getDevSession: mocks.devSession,
  getProductionSession: mocks.signedSession,
  getProductionUser: mocks.productionUser,
}));
vi.mock("@workspace/db", () => ({ pool: { query: mocks.dbQuery } }));

import companiesRouter from "../routes/companies";

describe("Company API accepts verified OTP sessions in DEV", () => {
  let server: http.Server;
  beforeAll(async () => {
    const app = express();
    app.use("/api", companiesRouter);
    server = await new Promise<http.Server>((resolve) => {
      const value = app.listen(0, "127.0.0.1", () => resolve(value));
    });
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.dbQuery.mockResolvedValue({ rows: [] });
    mocks.devSession.mockReturnValue(null);
    mocks.signedSession.mockReturnValue({ id: "uid-1", email: "admin@example.com", expiresAt: Date.now() + 60_000 });
    mocks.productionUser.mockResolvedValue({ email: "admin@example.com", role: "admin", companyId: 5 });
  });
  const request = async (cookie?: string) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No port");
    return await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.get({
        host: "127.0.0.1", port: addr.port, path: "/api/companies",
        headers: cookie ? { cookie } : {},
      }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
    });
  };

  it("accepts a verified signed OTP session and respects company scope", async () => {
    const response = await request("bizportal_supabase_session=valid");
    expect(response.status).toBe(200);
    expect(mocks.productionUser).toHaveBeenCalledTimes(1);
    expect(mocks.dbQuery).toHaveBeenCalledTimes(1);
    expect(mocks.dbQuery.mock.calls[0][1]).toEqual([5]);
  });

  it("rejects a missing or invalid signed session", async () => {
    mocks.signedSession.mockReturnValue(null);
    const response = await request();
    expect(response.status).toBe(401);
    expect(mocks.dbQuery).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized signed session without querying companies", async () => {
    mocks.productionUser.mockResolvedValue(null);
    const response = await request("bizportal_supabase_session=invalid");
    expect(response.status).toBe(401);
    expect(mocks.dbQuery).not.toHaveBeenCalled();
  });

  it("continues to accept legacy DEV session with its company scope", async () => {
    mocks.devSession.mockReturnValue({ email: "dev@example.com", role: "admin", companyId: 3 });
    const response = await request("bizportal_dev_session=valid");
    expect(response.status).toBe(200);
    expect(mocks.productionUser).not.toHaveBeenCalled();
    expect(mocks.dbQuery.mock.calls[0][1]).toEqual([3]);
  });
});
