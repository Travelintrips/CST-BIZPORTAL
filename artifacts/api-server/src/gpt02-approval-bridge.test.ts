import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import app from "./app";

describe("GPT02 DEV approval bridge", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server unavailable");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.close();
    await once(server, "close");
  });

  it("forwards only the browser URL fragment to the GPT02 approval page", async () => {
    const res = await fetch(`${baseUrl}/gpt02-approval-bridge`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await res.text();
    expect(body).toContain("https://dev.cstlogistic.co.id/gpt02-approval-api/");
    expect(body).toContain("location.hash");
    expect(body).not.toContain("location.search");
  });
});
