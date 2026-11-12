import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import { once } from "node:events";

const state = vi.hoisted(() => ({
  session: null as null | { id: string; email: string; issuedAt: number; expiresAt: number },
  actor: null as null | { id: string; email: string; role: string; companyId: number | null; firstName: string | null; lastName: string | null },
  queries: [] as Array<{ sql: string; values?: unknown[] }>,
  role: [] as string[],
  activeUser: true,
}));
vi.mock("./dev-auth", () => ({
  getProductionSession: () => state.session,
  getProductionUser: async () => state.actor,
}));
vi.mock("@workspace/db", () => ({
  pool: {
    query: async (sql: string) => {
      if (sql.includes("FROM public.users")) return {rows:state.activeUser?[{ok:1}]:[],rowCount:state.activeUser?1:0};
      throw Error("Unexpected unscoped HRD query");
    },
    connect: async () => ({
    query: async (sql: string, values?: unknown[]) => {
      state.queries.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL ROLE")) state.role.push(sql);
      if (sql.includes("current_user AS current_role")) {
        return { rows:[{current_role:"bizportal_hrd_prod",tenant_scope:String(state.actor?.companyId??"")}],rowCount:1 };
      }
      if (sql.includes("FROM public.employees")) {
        const companyId = Number(values?.[values.length - 1]);
        if (companyId !== 1) return { rows: [], rowCount: 0 };
        return { rows: [{ id: 10, company_id: 1, first_name: "Synthetic", last_name: "Employee" }], rowCount: 1 };
      }
      if (sql.includes("hrd_private.employee_profiles")) return { rows: [], rowCount: 0 };
      if (sql.includes("hrd_private.employee_documents")) return { rows: [], rowCount: 0 };
      if (sql.includes("hrd_private.employee_document_audit")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  }) },
}));
import hrdRouter from "./hrd-routes";

describe("HRD production API company isolation", () => {
  let server: ReturnType<typeof createServer>;
  let root: string;
  const originalHrdProdEnabled = process.env.HRD_PROD_ENABLED;
  afterEach(async () => {
    if (originalHrdProdEnabled === undefined) delete process.env.HRD_PROD_ENABLED;
    else process.env.HRD_PROD_ENABLED = originalHrdProdEnabled;
    state.session = null; state.actor = null; state.activeUser=true; state.queries.length = 0; state.role.length = 0;
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function start() {
    process.env.HRD_PROD_ENABLED = "true";
    const app = express(); app.use("/api", hrdRouter);
    server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw Error("no address");
    root = "http://127.0.0.1:" + address.port;
  }
  it("stays dormant without an explicit production HRD release flag", async () => {
    await start();
    delete process.env.HRD_PROD_ENABLED;
    state.session = {id:"u1",email:"test@example.test",issuedAt:Date.now(),expiresAt:Date.now()+60000};
    state.actor = {id:"u1",email:"test@example.test",role:"super_admin",companyId:1,firstName:null,lastName:null};
    const paths=[
      "/api/hrd/readiness?companyId=1",
      "/api/hrd/employees?companyId=1",
      "/api/hrd/employees/10?companyId=1",
    ];
    for(const path of paths) {
      const response=await fetch(root+path);
      expect(response.status).toBe(404);
    }
    expect(state.queries).toHaveLength(0);
  });

  it("rejects anonymous calls before touching DB", async () => {
    await start();
    const response = await fetch(root + "/api/hrd/employees?companyId=1");
    expect(response.status).toBe(401); expect(state.queries).toHaveLength(0);
  });
  it("rejects an owner selecting another company", async () => {
    state.session = { id: "u1", email: "hr@example.test", issuedAt: Date.now(), expiresAt: Date.now()+60000 };
    state.actor = { id: "u1", email: "hr@example.test", role: "owner", companyId: 1, firstName: null, lastName: null };
    await start();
    const response = await fetch(root + "/api/hrd/employees?companyId=3");
    expect(response.status).toBe(403); expect(state.queries).toHaveLength(0);
  });
  it("denies anonymous photo preparation before storage or database access", async () => {
    await start();
    const response=await fetch(root + "/api/hrd/employees/10/photo/prepare?companyId=1", {
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({mimeType:"image/jpeg",processingAuthorizationConfirmed:true}),
    });
    expect(response.status).toBe(401);
    expect(state.queries).toHaveLength(0);
  });
  it("denies owner photo preparation before storage or database access", async () => {
    state.session={id:"u1",email:"hr@example.test",issuedAt:Date.now(),expiresAt:Date.now()+60000};
    state.actor={id:"u1",email:"hr@example.test",role:"owner",companyId:1,firstName:null,lastName:null};
    await start();
    const response=await fetch(root + "/api/hrd/employees/10/photo/prepare?companyId=3", {
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({mimeType:"image/jpeg",processingAuthorizationConfirmed:true}),
    });
    expect(response.status).toBe(403);
    expect(state.queries).toHaveLength(0);
  });
  it("keeps photo upload unavailable until private PROD storage is enabled", async () => {
    state.session={id:"u1",email:"hr@example.test",issuedAt:Date.now(),expiresAt:Date.now()+60000};
    state.actor={id:"u1",email:"hr@example.test",role:"super_admin",companyId:1,firstName:null,lastName:null};
    await start();
    const response=await fetch(root + "/api/hrd/employees/10/photo/prepare?companyId=1", {
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({mimeType:"image/jpeg",processingAuthorizationConfirmed:true}),
    });
    expect(response.status).toBe(503);
    expect(state.queries).toHaveLength(0);
  });
  it("refuses a disabled HRD account even with a signed session", async () => {
    state.session={id:"u1",email:"hr@example.test",issuedAt:Date.now(),expiresAt:Date.now()+60000};
    state.actor={id:"u1",email:"hr@example.test",role:"super_admin",companyId:1,firstName:null,lastName:null};
    state.activeUser=false;
    await start();
    const response=await fetch(root+"/api/hrd/employees?companyId=1");
    expect(response.status).toBe(403);
    expect(state.queries).toHaveLength(0);
  });
  it("validates production role and transaction-local scope without returning employee data", async () => {
    state.session={id:"u1",email:"hr@example.test",issuedAt:Date.now(),expiresAt:Date.now()+60000};
    state.actor={id:"u1",email:"hr@example.test",role:"super_admin",companyId:1,firstName:null,lastName:null};
    await start();
    const response=await fetch(root+"/api/hrd/readiness?companyId=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ready:true,companyId:1,roleIsolated:true});
    expect(state.role).toEqual(["BEGIN","SET LOCAL ROLE bizportal_hrd_prod","COMMIT"]);
  });
  it("reads only the selected company in a transaction-local HRD role", async () => {
    state.session = { id: "u1", email: "hr@example.test", issuedAt: Date.now(), expiresAt: Date.now()+60000 };
    state.actor = { id: "u1", email: "hr@example.test", role: "super_admin", companyId: 1, firstName: null, lastName: null };
    await start();
    const response = await fetch(root + "/api/hrd/employees?companyId=1");
    expect(response.status).toBe(200);
    const body = await response.json() as { companyId: number; employees: Array<{company_id:number}> };
    expect(body.companyId).toBe(1); expect(body.employees.every((x) => x.company_id === 1)).toBe(true);
    expect(state.role).toEqual(["BEGIN","SET LOCAL ROLE bizportal_hrd_prod","COMMIT"]);
    expect(state.queries[2].values).toEqual(["1"]);
  });
});
