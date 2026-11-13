/**
 * Gmail invoice OCR provider backpressure and review policy.
 *
 * Only the existing invoice-OCR pipeline uses this. A provider failure must
 * never silently become a payable invoice, even when PDF text fallback finds
 * an apparent number and total.
 */
export const MIN_OCR_RATE_LIMIT_DELAY_MS = 15 * 60 * 1000;
export const MAX_OCR_RATE_LIMIT_DELAY_MS = 60 * 60 * 1000;

export function rateLimitRetryAt(
  httpStatus: number,
  retryAfter: string | null,
  now = Date.now(),
): number | null {
  if (httpStatus !== 429) return null;
  const raw = (retryAfter ?? "").trim();
  let delay = MIN_OCR_RATE_LIMIT_DELAY_MS;

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    delay = Number(raw) * 1000;
  } else if (raw) {
    const retryTime = Date.parse(raw);
    if (Number.isFinite(retryTime)) delay = retryTime - now;
  }

  return now + Math.max(
    MIN_OCR_RATE_LIMIT_DELAY_MS,
    Math.min(MAX_OCR_RATE_LIMIT_DELAY_MS, Number.isFinite(delay) ? delay : MIN_OCR_RATE_LIMIT_DELAY_MS),
  );
}

export function requiresInvoiceExtractionReview(flags: readonly string[]): boolean {
  return flags.includes("FALLBACK_PDF_TEXT")
    || flags.includes("OCR_PROVIDER_ERROR");
}

/** Gmail sometimes responds with HTTP 403 and a dated "User-rate limit exceeded" message. */
export function gmailRateLimitRetryAt(
  httpStatus: number,
  retryAfter: string | null,
  providerMessage: string | null,
  now = Date.now(),
): number | null {
  const message = providerMessage ?? "";
  if (httpStatus !== 429 && !/user[- ]rate limit exceeded|rate limit exceeded|rate ?limit exceeded/i.test(message)) {
    return null;
  }
  const embeddedRetryAt = message.match(
    /retry after\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i,
  )?.[1] ?? null;
  return rateLimitRetryAt(429, retryAfter || embeddedRetryAt, now);
}

export class GmailProviderRateLimitError extends Error {
  constructor(public readonly retryAt: number) {
    super("Batas permintaan Gmail tercapai; sinkronisasi ditunda tanpa menandai invoice gagal.");
    this.name = "GmailProviderRateLimitError";
  }
}
