import {
  getDatabaseSecretName,
  pool,
  readSecret,
} from "@workspace/db";

const cache = new Map<string, { value: string; expiresAt: number }>();
let managedProductionBundlePromise:
  | Promise<Record<string, string>>
  | null = null;

function isProductionRuntime(): boolean {
  const environment = (
    process.env.APP_ENV ??
    process.env.NODE_ENV ??
    "development"
  )
    .trim()
    .toLowerCase();

  return environment === "production";
}

async function readManagedProductionConfig(
  key: string,
): Promise<string> {
  if (!isProductionRuntime()) return "";

  if (!managedProductionBundlePromise) {
    managedProductionBundlePromise = (async () => {
      const raw = await readSecret(
        getDatabaseSecretName(true),
      );

      const parsed = JSON.parse(raw) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new Error(
          "Managed production secret bundle is invalid",
        );
      }

      const values: Record<string, string> = {};
      for (const [bundleKey, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (
          typeof value === "string" &&
          value.trim()
        ) {
          values[bundleKey] = value.trim();
        }
      }

      return values;
    })().catch((error) => {
      managedProductionBundlePromise = null;
      throw error;
    });
  }

  const bundle =
    await managedProductionBundlePromise;
  return bundle[key]?.trim() ?? "";
}

export const GMAIL_SEARCH_QUERY =
  "newer_than:365d has:attachment {filename:pdf filename:jpg filename:jpeg filename:png filename:webp} {invoice tagihan faktur billing}";
export const GMAIL_MAX_MESSAGES = 30;
export const GMAIL_MAX_ATTACHMENTS = 6;
export const GMAIL_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export async function getRuntimeConfig(
  key: string,
): Promise<string> {
  const direct = process.env[key]?.trim();
  if (direct) return direct;

  const cached = cache.get(key);
  if (
    cached &&
    cached.expiresAt > Date.now()
  ) {
    return cached.value;
  }

  if (
    key === "OPENAI_API_KEY" &&
    isProductionRuntime()
  ) {
    try {
      const managed =
        await readManagedProductionConfig(key);
      if (managed) {
        cache.set(key, {
          value: managed,
          expiresAt: Date.now() + 60_000,
        });
        return managed;
      }
    } catch {
      // Fall through to app_config so production
      // remains available during a transient GCP
      // Secret Manager outage.
    }
  }

  try {
    const result =
      await pool.query<{ value: string | null }>(
        `select value from public.app_config
          where key=$1 and (
            environment in ('all','production')
            or environment is null
          )
          limit 1`,
        [key],
      );

    const value =
      result.rows[0]?.value?.trim() ?? "";

    cache.set(key, {
      value,
      expiresAt: Date.now() + 60_000,
    });

    return value;
  } catch {
    return "";
  }
}
