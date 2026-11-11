import {describe,expect,it} from "vitest";
import {hrdScanFailureMessage} from "../lib/hrdOcrError";

describe("HRD DEV OCR error handling",()=>{
 it("distinguishes temporary request/token limits from billing and quota limits",()=>{
  const rate=hrdScanFailureMessage("Scan gagal (kode HRD_OCR_PROVIDER_HTTP_429_RATE_LIMIT_EXCEEDED).");
  expect(rate).toContain("Batas permintaan/token");
  expect(rate).toContain("tunggu sampai batas reset");
  const quota=hrdScanFailureMessage("Scan gagal (kode HRD_OCR_PROVIDER_HTTP_429_CREDIT_BALANCE_EXHAUSTED).");
  expect(quota).toContain("saldo kredit");
  expect(quota).toContain("Jangan unggah ulang");
  const spend=hrdScanFailureMessage("Scan gagal (kode HRD_OCR_PROVIDER_HTTP_429_ORGANIZATION_SPEND_LIMIT_EXCEEDED).");
  expect(spend).toContain("batas pengeluaran");
 });
 it("does not guess the cause when only HTTP 429 is available",()=>{
  const text=hrdScanFailureMessage("Scan gagal (kode HRD_OCR_PROVIDER_HTTP_429).");
  expect(text).toContain("jenis batas belum teridentifikasi");
  expect(text).toContain("Jangan unggah ulang");
 });
 it("preserves non-429 errors for diagnosis",()=>{
  expect(hrdScanFailureMessage("Upload privat gagal.")).toBe("Upload privat gagal.");
 });
});
