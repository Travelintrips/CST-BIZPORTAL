import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSpreadsheetValues } from "./google-sheets";

const originalServiceAccount = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const serviceAccount = JSON.stringify({
  client_email: "sheet-sync-test@example.iam.gserviceaccount.com",
  private_key: privateKey,
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalServiceAccount === undefined) {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  } else {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = originalServiceAccount;
  }
});

beforeEach(() => {
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = serviceAccount;
});

describe("Google Sheets writes", () => {
  it("sends batch updates through the Sheets API", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "test-access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ updatedCells: 2 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await writeSpreadsheetValues("spreadsheet-1", [
      { range: "'Mutasi Bank'!E1", values: [["mutation_key"]] },
      { range: "'Mutasi Bank'!E2", values: [["canonical-key"]] },
    ]);

    const [requestUrl, requestInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(requestUrl)).toContain("/v4/spreadsheets/spreadsheet-1/values:batchUpdate");
    expect(requestInit.method).toBe("POST");
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: "'Mutasi Bank'!E1",
          majorDimension: "ROWS",
          values: [["mutation_key"]],
        },
        {
          range: "'Mutasi Bank'!E2",
          majorDimension: "ROWS",
          values: [["canonical-key"]],
        },
      ],
    });
  });

  it("reports missing Editor access when Google rejects a write", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "test-access-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      writeSpreadsheetValues("spreadsheet-1", [
        { range: "'Mutasi Bank'!F2", values: [["UNMATCHED"]] },
      ]),
    ).rejects.toThrow("Spreadsheet tidak dapat ditulis. Pastikan Service Account memiliki akses Editor");
  });
});