import { pool } from "@workspace/db";

const cache = new Map<string, { value: string; expiresAt: number }>();

export const GMAIL_SEARCH_QUERY =
  "newer_than:365d has:attachment {filename:pdf filename:jpg filename:jpeg filename:png filename:webp} {invoice tagihan faktur billing}";
export const GMAIL_MAX_MESSAGES = 30;
export const GMAIL_MAX_ATTACHMENTS = 30;
export const GMAIL_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export async function getRuntimeConfig(key: string): Promise<string> {
  const direct = process.env[key]?.trim();
  if (direct) return direct;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const result = await pool.query<{ value: string | null }>(
      `select value from public.app_config
        where key=$1 and (environment in ('all','production') or environment is null)
        limit 1`,
      [key],
    );
    const value = result.rows[0]?.value?.trim() ?? "";
    cache.set(key, { value, expiresAt: Date.now() + 60_000 });
    return value;
  } catch {
    return "";
  }
}
