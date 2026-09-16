import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnvironment = {
  APP_ENV: process.env.APP_ENV,
  NODE_ENV: process.env.NODE_ENV,
  BIZPORTAL_API_ORIGIN_DEV: process.env.BIZPORTAL_API_ORIGIN_DEV,
  BIZPORTAL_API_ORIGIN_PROD: process.env.BIZPORTAL_API_ORIGIN_PROD,
  BIZPORTAL_API_ORIGIN: process.env.BIZPORTAL_API_ORIGIN,
  GCP_SECRET_MANAGER_BOOTSTRAP_JSON: process.env.GCP_SECRET_MANAGER_BOOTSTRAP_JSON,
};

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  vi.resetModules();
});

describe("configured BizPortal API origin", () => {
  it("loads a stable HTTPS development origin", async () => {
    process.env.APP_ENV = "development";
    delete process.env.NODE_ENV;
    process.env.BIZPORTAL_API_ORIGIN_DEV = "https://bizportal.cstlogistic.co.id";

    const { getConfiguredUpstreamOrigin } = await import("./gcp-secrets");

    await expect(getConfiguredUpstreamOrigin()).resolves.toEqual(
      new URL("https://bizportal.cstlogistic.co.id/"),
    );
  });

  it("rejects an ephemeral development origin without exposing the secret value", async () => {
    process.env.APP_ENV = "development";
    delete process.env.NODE_ENV;
    const secretOrigin = "https://temporary-api-secret-123.replit.dev";
    process.env.BIZPORTAL_API_ORIGIN_DEV = secretOrigin;

    const { getConfiguredUpstreamOrigin } = await import("./gcp-secrets");

    const error = await getConfiguredUpstreamOrigin().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "BIZPORTAL_API_ORIGIN_DEV API origin failed validation",
    );
    expect((error as Error).message).not.toContain(secretOrigin);
  });
});