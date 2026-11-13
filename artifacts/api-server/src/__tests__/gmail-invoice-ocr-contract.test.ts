import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../lib/gmail-invoice-ocr.ts", import.meta.url),
  "utf8",
);

describe("Gmail invoice OCR Responses contract", () => {
  it("uses a current multimodal Responses model by default", () => {
    expect(source).toContain('"gpt-6-luna"');
    expect(source).toContain('https://api.openai.com/v1/responses');
  });

  it("forces structured JSON and high-detail PDF processing", () => {
    expect(source).toContain('type: "json_schema"');
    expect(source).toContain('name: "gmail_invoice_extraction"');
    expect(source).toContain('strict: true');
    expect(source).toContain('type: "input_file"');
    expect(source).toContain('detail: "high"');
  });
});
