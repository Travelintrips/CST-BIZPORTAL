import { describe, expect, it } from "vitest";
import {
  MAX_OCR_RATE_LIMIT_DELAY_MS,
  MIN_OCR_RATE_LIMIT_DELAY_MS,
  rateLimitRetryAt,
  gmailRateLimitRetryAt,
  GmailProviderRateLimitError,
  requiresInvoiceExtractionReview,
} from "../lib/gmail-invoice-rate-limit";

describe("Gmail invoice OCR backpressure", () => {
  const now = Date.parse("2026-11-13T10:00:00.000Z");

  it("does not open a circuit for non-rate-limit errors", () => {
    expect(rateLimitRetryAt(503, "3600", now)).toBeNull();
  });

  it("uses at least 15 minutes when Retry-After is absent or too short", () => {
    expect(rateLimitRetryAt(429, null, now)).toBe(now + MIN_OCR_RATE_LIMIT_DELAY_MS);
    expect(rateLimitRetryAt(429, "2", now)).toBe(now + MIN_OCR_RATE_LIMIT_DELAY_MS);
  });

  it("honors Retry-After seconds while capping at one hour", () => {
    expect(rateLimitRetryAt(429, "1800", now)).toBe(now + 1_800_000);
    expect(rateLimitRetryAt(429, "100000", now)).toBe(now + MAX_OCR_RATE_LIMIT_DELAY_MS);
  });

  it("handles HTTP dates and malformed headers safely", () => {
    expect(rateLimitRetryAt(429, new Date(now + 30 * 60_000).toUTCString(), now))
      .toBe(now + 30 * 60_000);
    expect(rateLimitRetryAt(429, "not a date", now))
      .toBe(now + MIN_OCR_RATE_LIMIT_DELAY_MS);
  });


  it("recognizes Google Gmail 403 user-rate-limit messages with explicit UTC retry", () => {
    const retry = new Date(now + 25 * 60_000).toISOString();
    expect(gmailRateLimitRetryAt(403, null, "User-rate limit exceeded. Retry after " + retry, now))
      .toBe(now + 25 * 60_000);
  });

  it("does not convert unrelated Gmail 403 permissions errors into cooldown", () => {
    expect(gmailRateLimitRetryAt(403, null, "Insufficient permission", now)).toBeNull();
    expect(gmailRateLimitRetryAt(429, null, null, now)).toBe(now + MIN_OCR_RATE_LIMIT_DELAY_MS);
  });

  it("propagates a typed, secret-free Gmail retry marker", () => {
    const marker = new GmailProviderRateLimitError(now + 30_000);
    expect(marker.retryAt).toBe(now + 30_000);
    expect(marker.name).toBe("GmailProviderRateLimitError");
  });

  it("never promotes PDF-text or provider-error fallback to OCR-ready", () => {
    expect(requiresInvoiceExtractionReview(["FALLBACK_PDF_TEXT"])).toBe(true);
    expect(requiresInvoiceExtractionReview(["OCR_PROVIDER_ERROR"])).toBe(true);
    expect(requiresInvoiceExtractionReview(["FALLBACK_PDF_TEXT", "OCR_PROVIDER_ERROR"])).toBe(true);
    expect(requiresInvoiceExtractionReview([])).toBe(false);
  });
});
