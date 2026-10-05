import test from "node:test";
import assert from "node:assert/strict";
import { assertFleetEnvironmentIsolation } from "./environment.mjs";
import { createCentralFinanceClient } from "./central-finance-client.mjs";
import { createFleetWaGatewayClient } from "./wa-gateway-client.mjs";

test("DEV rejects obvious PROD database markers", () => {
  assert.throws(() => assertFleetEnvironmentIsolation({
    APP_ENV: "development",
    APP_BASE_URL: "https://dev-fleet.cstlogistic.co.id",
    DATABASE_URL: "postgres://user@prod-db/fleet"
  }), /PROD database marker/);
});

test("PROD rejects obvious DEV database markers", () => {
  assert.throws(() => assertFleetEnvironmentIsolation({
    APP_ENV: "production",
    APP_BASE_URL: "https://fleet.cstlogistic.co.id",
    DATABASE_URL: "postgres://user@dev-db/fleet",
    AUTH_CLIENT_SECRET: "x"
  }), /DEV\/staging\/test database marker/);
});

test("Central Finance writes are disabled by default", async () => {
  const client=createCentralFinanceClient({
    CENTRAL_FINANCE_BASE_URL:"https://finance.example.test",
    CENTRAL_FINANCE_SERVICE_TOKEN:"token"
  }, async () => new Response("{}", {status:200,headers:{"content-type":"application/json"}}));
  await assert.rejects(
    client.postFleetCashPayment({companyId:1,paymentId:1,idempotencyKey:"k",payload:{}}),
    /writes are disabled/
  );
});

test("WA Gateway client normalizes Indonesian phone numbers", async () => {
  let body=null;
  const client=createFleetWaGatewayClient({
    CST_WA_GATEWAY_URL:"https://wa.example.test",
    CST_WA_GATEWAY_TOKEN:"token"
  }, async (_url, init) => {
    body=JSON.parse(init.body);
    return new Response(JSON.stringify({ok:true}), {status:200,headers:{"content-type":"application/json"}});
  });
  await client.send({phone:"0812-3456-7890",message:"test",idempotencyKey:"k"});
  assert.equal(body.to,"6281234567890");
  assert.equal(body.source,"fleet-intelligence");
});
