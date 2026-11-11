import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const mocked = vi.hoisted(() => ({
  query: vi.fn(),
  session: vi.fn(),
  isDev: vi.fn(),
}));
vi.mock("@workspace/db", () => ({ pool: { query: mocked.query } }));
vi.mock("./dev-auth", () => ({
  getDevSession: mocked.session,
  isDevelopmentEnvironment: mocked.isDev,
}));

import router from "./dev-marketplace-read-parity";

let server: Server;
let base: string;
beforeAll(async () => {
  const app=express();
  app.use("/api",router);
  server=app.listen(0);
  await new Promise<void>((resolve)=>server.once("listening",resolve));
  base="http://127.0.0.1:"+(server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
});
beforeEach(() => {
  mocked.query.mockReset();
  mocked.session.mockReset();
  mocked.isDev.mockReset();
  mocked.isDev.mockReturnValue(true);
  mocked.session.mockReturnValue({email:"admin@dev.test",role:"admin"});
  mocked.query.mockResolvedValue({rows:[]});
});
describe("DEV-only Marketplace read parity security", () => {
  it.each(["/api/mkt/admin/rfqs", "/api/mkt/admin/purchase-orders"])("returns 404 outside DEV: %s", async path => {
    mocked.isDev.mockReturnValue(false);
    const res=await fetch(base+path);
    expect(res.status).toBe(404);
    expect(mocked.query).not.toHaveBeenCalled();
  });
  it.each(["/api/mkt/admin/rfqs", "/api/mkt/admin/purchase-orders"])("requires signed DEV session: %s", async path => {
    mocked.session.mockReturnValue(null);
    const res=await fetch(base+path);
    expect(res.status).toBe(401);
    expect(mocked.query).not.toHaveBeenCalled();
  });
  it.each(["customer","vendor","employee"])("refuses non-admin role %s", async role => {
    mocked.session.mockReturnValue({role,email:"other@dev.test"});
    const res=await fetch(base+"/api/mkt/admin/rfqs");
    expect(res.status).toBe(403);
    expect(mocked.query).not.toHaveBeenCalled();
  });
  it.each(["admin","owner","super_admin"])("permits DEV role %s", async role => {
    mocked.session.mockReturnValue({role,email:"admin@dev.test"});
    const res=await fetch(base+"/api/mkt/admin/rfqs?limit=5");
    expect(res.status).toBe(200);
    expect(mocked.query).toHaveBeenCalledWith(expect.stringContaining("from public.mkt_rfqs"),[5]);
  });
  it("uses bounded parameterized read for PO, returns UI contract", async () => {
    mocked.query.mockResolvedValue({rows:[{id:42,poNumber:"DEV-PO-42",rfqId:21}]});
    const res=await fetch(base+"/api/mkt/admin/purchase-orders?limit=99999");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok:true,data:[{id:42,poNumber:"DEV-PO-42",rfqId:21}],count:1});
    const [sql,params]=mocked.query.mock.calls[0];
    expect(sql).toContain("from public.mkt_purchase_orders");
    expect(params).toEqual([200]);
  });
  it("does not provide write operations", async () => {
    const res=await fetch(base+"/api/mkt/admin/rfqs",{method:"POST"});
    expect(res.status).toBe(404);
    expect(mocked.query).not.toHaveBeenCalled();
  });
});
