import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnvironment = {
  APP_ENV: process.env.APP_ENV,
  NODE_ENV: process.env.NODE_ENV,
  BIZPORTAL_API_ORIGIN_DEV: process.env.BIZPORTAL_API_ORIGIN_DEV,
  BIZPORTAL_API_ORIGIN_PROD: process.env.BIZPORTAL_API_ORIGIN_PROD,
  BIZPORTAL_BACKEND_API_ORIGIN: process.env.BIZPORTAL_BACKEND_API_ORIGIN,
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

beforeEach(() => {
  delete process.env.BIZPORTAL_BACKEND_API_ORIGIN;
  delete process.env.BIZPORTAL_API_ORIGIN;
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

  it("uses the explicit development origin without consulting another environment", async () => {
    process.env.APP_ENV = "development";
    delete process.env.NODE_ENV;
    const developmentOrigin = "https://temporary-api-secret-123.replit.dev";
    process.env.BIZPORTAL_API_ORIGIN_DEV = developmentOrigin;

    const { getConfiguredUpstreamOrigin } = await import("./gcp-secrets");

    await expect(getConfiguredUpstreamOrigin()).resolves.toEqual(new URL(developmentOrigin));
  });

  it("does not use the GCP payload or a production origin for development", async () => {
    process.env.APP_ENV = "development";
    delete process.env.NODE_ENV;
    delete process.env.BIZPORTAL_API_ORIGIN_DEV;
    process.env.BIZPORTAL_API_ORIGIN_PROD = "https://production.example.test";
    process.env.GCP_SECRET_MANAGER_BOOTSTRAP_JSON = "{\"project_id\":\"redacted\"}";

    const { getConfiguredUpstreamOrigin } = await import("./gcp-secrets");

    await expect(getConfiguredUpstreamOrigin()).rejects.toThrow(
      "BIZPORTAL_API_ORIGIN_DEV is not configured",
    );
  });

  it("requires the production origin and rejects a Replit development host", async () => {
    process.env.APP_ENV = "production";
    delete process.env.NODE_ENV;
    delete process.env.BIZPORTAL_API_ORIGIN_PROD;
    process.env.BIZPORTAL_API_ORIGIN_DEV = "https://development.example.test";

    const { getConfiguredUpstreamOrigin } = await import("./gcp-secrets");

    await expect(getConfiguredUpstreamOrigin()).rejects.toThrow(
      "BIZPORTAL_API_ORIGIN_PROD is not configured",
    );

    vi.resetModules();
    process.env.BIZPORTAL_API_ORIGIN_PROD = "https://temporary-api-secret-123.replit.dev";
    const productionModule = await import("./gcp-secrets");
    await expect(productionModule.getConfiguredUpstreamOrigin()).rejects.toThrow(
      "BIZPORTAL_API_ORIGIN_PROD cannot use an ephemeral Replit development host",
    );
  });

  it("ignores a development backend origin in production", async () => {
    process.env.APP_ENV = "production";
    delete process.env.NODE_ENV;
    process.env.BIZPORTAL_BACKEND_API_ORIGIN = "http://127.0.0.1:18444";
    process.env.BIZPORTAL_API_ORIGIN_PROD = "https://production.example.test";

    const { getConfiguredUpstreamOrigin } = await import("./gcp-secrets");

    await expect(getConfiguredUpstreamOrigin()).resolves.toEqual(
      new URL("https://production.example.test/"),
    );
  });
});