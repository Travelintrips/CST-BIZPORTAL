import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const mocked = vi.hoisted(() => ({
  query: vi.fn(),
  session: vi.fn(),
  verifiedSession: vi.fn(),
  verifiedUser: vi.fn(),
  isDev: vi.fn(),
}));
vi.mock("@workspace/db", () => ({ pool: { query: mocked.query } }));
vi.mock("./dev-auth", () => ({
  getDevSession: mocked.session,
  getProductionSession: mocked.verifiedSession,
  getProductionUser: mocked.verifiedUser,
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
  mocked.verifiedSession.mockReset();
  mocked.verifiedUser.mockReset();
  mocked.isDev.mockReset();
  mocked.isDev.mockReturnValue(true);
  mocked.session.mockReturnValue({email:"admin@dev.test",role:"admin"});
  mocked.verifiedSession.mockReturnValue(null);
  mocked.verifiedUser.mockResolvedValue(null);
  mocked.query.mockResolvedValue({rows:[]});
});
describe("Separated BizPortal route mounting contract", () => {
  it("mounts Marketplace DEV route before global accounting and legacy auth middlewares", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const devRoute = source.indexOf("router.use(devMarketplaceReadParityRouter);");
    const accounting = source.indexOf("router.use(accountingRouter);");
    const legacy = source.indexOf("router.use(legacyReadParityRouter);");
    const auth = source.indexOf("router.use(localProductionAuthRouter);");
    expect(auth).toBeGreaterThanOrEqual(0);
    expect(devRoute).toBeGreaterThan(auth);
    expect(devRoute).toBeLessThan(accounting);
    expect(devRoute).toBeLessThan(legacy);
  });
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

  it.each(["/api/mkt/admin/rfqs", "/api/mkt/admin/purchase-orders"])("accepts only verified BizPortal OTP admin session: %s", async path => {
    mocked.session.mockReturnValue(null);
    mocked.verifiedSession.mockReturnValue({email:"admin@dev.test",id:"valid-supabase-user"});
    mocked.verifiedUser.mockResolvedValue({email:"admin@dev.test",role:"admin"});
    const res=await fetch(base+path);
    expect(res.status).toBe(200);
    expect(mocked.verifiedUser).toHaveBeenCalledOnce();
    expect(mocked.query).toHaveBeenCalledOnce();
  });
  it("rejects signed OTP session without an active BizPortal account", async () => {
    mocked.session.mockReturnValue(null);
    mocked.verifiedSession.mockReturnValue({email:"unknown@dev.test",id:"unknown"});
    mocked.verifiedUser.mockResolvedValue(null);
    const res=await fetch(base+"/api/mkt/admin/rfqs");
    expect(res.status).toBe(403);
    expect(mocked.query).not.toHaveBeenCalled();
  });
  it("rejects customer role resolved from database even with signed OTP session", async () => {
    mocked.session.mockReturnValue(null);
    mocked.verifiedSession.mockReturnValue({email:"customer@dev.test",id:"customer"});
    mocked.verifiedUser.mockResolvedValue({email:"customer@dev.test",role:"customer"});
    const res=await fetch(base+"/api/mkt/admin/purchase-orders");
    expect(res.status).toBe(403);
    expect(mocked.query).not.toHaveBeenCalled();
  });
  it("returns 503 rather than bypassing authorization if the admin lookup fails", async () => {
    mocked.session.mockReturnValue(null);
    mocked.verifiedSession.mockReturnValue({email:"admin@dev.test",id:"admin"});
    mocked.verifiedUser.mockRejectedValue(new Error("dev database offline"));
    const res=await fetch(base+"/api/mkt/admin/rfqs");
    expect(res.status).toBe(503);
    expect(mocked.query).not.toHaveBeenCalled();
  });
  it("rejects an unverified cookie or role header without any signed session", async () => {
    mocked.session.mockReturnValue(null);
    mocked.verifiedSession.mockReturnValue(null);
    const res=await fetch(base+"/api/mkt/admin/rfqs",{headers:{role:"admin",cookie:"portal_session=forged"}});
    expect(res.status).toBe(401);
    expect(mocked.query).not.toHaveBeenCalled();
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
  it("keeps finance readiness unavailable in PROD and to anonymous users", async () => {
    mocked.isDev.mockReturnValue(false);
    expect((await fetch(base+"/api/mkt/admin/purchase-orders/2/finance-readiness")).status).toBe(404);
    mocked.isDev.mockReturnValue(true);
    mocked.session.mockReturnValue(null);
    expect((await fetch(base+"/api/mkt/admin/purchase-orders/2/finance-readiness")).status).toBe(401);
    mocked.session.mockReturnValue({role:"vendor",email:"vendor@dev.test"});
    expect((await fetch(base+"/api/mkt/admin/purchase-orders/2/finance-readiness")).status).toBe(403);
    expect(mocked.query).not.toHaveBeenCalled();
  });
  it("validates PO IDs before any database access", async () => {
    for(const id of ["bad", "0", "999999999999999999999999"]) {
      expect((await fetch(base+`/api/mkt/admin/purchase-orders/${id}/finance-readiness`)).status).toBe(400);
    }
    expect(mocked.query).not.toHaveBeenCalled();
  });
  it("reports missing finance prerequisites without writing or auto-posting", async () => {
    mocked.query.mockResolvedValue({rows:[{
      id:2,poNumber:"DEV-PO-2",companyId:null,status:"completed",paymentStatus:"unpaid",
      receiptCount:1,vendorInvoiceCount:0,matchedVendorInvoiceCount:0,
      apPreparationCount:0,accountingHandoffCount:0,
    }]});
    const res=await fetch(base+"/api/mkt/admin/purchase-orders/2/finance-readiness");
    expect(res.status).toBe(200);
    const body=await res.json() as {readOnly:boolean; blockers:string[]};
    expect(body.readOnly).toBe(true);
    expect(body.blockers).toEqual([
      "COMPANY_UNASSIGNED", "VENDOR_INVOICE_MISSING", "AP_PREPARATION_MISSING", "ACCOUNTING_HANDOFF_MISSING",
    ]);
    expect(mocked.query).toHaveBeenCalledOnce();
    const [sql,params]=mocked.query.mock.calls[0];
    expect(sql.toLowerCase()).toMatch(/^select /);
    expect(sql.toLowerCase()).not.toMatch(/\b(insert|update|delete|truncate)\b/);
    expect(params).toEqual([2]);
    expect(sql).toContain("vi.company_id=p.company_id");
    expect(sql).toContain("vi.supplier_id=p.vendor_id");
    expect(sql).toContain("gr.inspection_status='passed'");
    expect(sql).toContain("sh.shipment_status='delivered'");
    expect(sql).toContain("vi.three_way_match_status='passed'");
    expect(sql).toContain("ap.mkt_goods_receipt_id=vi.mkt_goods_receipt_id");
    expect(sql).toContain("ah.company_id=p.company_id");
    expect((await fetch(base+"/api/mkt/admin/purchase-orders/2/finance-readiness",{method:"POST"})).status).toBe(404);
  });
  it("reports a missing PO without any write", async () => {
    mocked.query.mockResolvedValue({rows:[]});
    expect((await fetch(base+"/api/mkt/admin/purchase-orders/999/finance-readiness")).status).toBe(404);
    expect(mocked.query).toHaveBeenCalledOnce();
  });
});
