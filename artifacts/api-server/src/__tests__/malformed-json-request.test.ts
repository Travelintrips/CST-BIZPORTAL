import http, { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../app";

let server: Server;
let port: number;

function postRawJson(body: string): Promise<{ status: number; body: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/__malformed-json-probe",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 500,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: response.headers["content-type"],
          });
        });
      },
    );

    request.on("error", reject);
    request.end(body);
  });
}

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("malformed JSON request handling", () => {
  it("returns a structured 400 response instead of the default Express stack response", async () => {
    const response = await postRawJson("{invalid:true}");

    expect(response.status).toBe(400);
    expect(response.contentType).toContain("application/json");
    expect(JSON.parse(response.body)).toEqual({
      error: "INVALID_JSON",
      message: "Request body must be valid JSON.",
    });
  });
});
