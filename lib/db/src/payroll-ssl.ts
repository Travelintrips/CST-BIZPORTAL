import { X509Certificate } from "node:crypto";

// Public Supabase Root 2021 CA trust anchor for the isolated Payroll PROD pool.
// SHA-256 DER fingerprint:
// 807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA
// Verify the public root against Supabase project dashboard before CA rotation.
// Never include any client private keys or live database credentials.
export const SUPABASE_ROOT_2021_CA_PEM = "-----BEGIN CERTIFICATE-----\nMIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL\nBQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l\ndyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh\nc2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow\nazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD\nYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug\nUm9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW\nQyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q\nDmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2\nGtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi\ncvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4\nO4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt\nNaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX\nuXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt\naUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU\ntVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b\nVW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6\njB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx\nCea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2\nCMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P\no/bKiIz+Fq8=\n-----END CERTIFICATE-----\n";
export const SUPABASE_ROOT_2021_CA_SHA256 =
  "807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa";

/**
 * Isolated Payroll TLS only; never changes BizPortal's shared database pool.
 * The pg-connection-string parser overwrites a supplied ssl object whenever
 * the URL includes sslmode/sslrootcert. Strip TLS mode from a copy of the URL
 * and inject verified TLS options explicitly, never weakening checks.
 */
export function buildPayrollDedicatedSslOptions(connectionString: string) {
  const url = new URL(connectionString);
  const host = url.hostname.toLowerCase();
  if (!(/^aws-[0-9]+-[a-z0-9-]+\\.pooler\\.supabase\\.com$/.test(host) ||
        host === "db.nzdweipzckfszczzqtuw.supabase.co")) {
    throw new Error("PAYROLL_PROD_TLS_HOST_NOT_ALLOWED");
  }

  const requestedMode = url.searchParams.get("sslmode")?.toLowerCase();
  if (requestedMode && !["require", "verify-full"].includes(requestedMode))
    throw new Error("PAYROLL_PROD_TLS_MODE_NOT_ALLOWED");
  if (url.searchParams.has("sslcert") || url.searchParams.has("sslkey") ||
      url.searchParams.has("sslrootcert") || url.searchParams.has("ssl") ||
      url.searchParams.has("uselibpqcompat"))
    throw new Error("PAYROLL_PROD_TLS_URL_PARAMETERS_NOT_ALLOWED");

  const root = new X509Certificate(SUPABASE_ROOT_2021_CA_PEM);
  if (root.fingerprint256.replaceAll(":", "").toLowerCase() !== SUPABASE_ROOT_2021_CA_SHA256)
    throw new Error("PAYROLL_PROD_TRUST_ANCHOR_PIN_MISMATCH");

  // Node TLS verifies both the chain and hostname; no insecure fallback.
  url.searchParams.delete("sslmode");
  return {
    connectionString: url.toString(),
    ssl: {
      ca: SUPABASE_ROOT_2021_CA_PEM,
      rejectUnauthorized: true as const,
      servername: host,
    },
  };
}
