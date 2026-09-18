import { afterEach, describe, expect, it } from "vitest";
import { getDatabaseUrl, resolveDatabaseUrl } from "@workspace/db/connection";
import {
  extractDatabaseUrl,
  validateDatabaseUrl,
} from "@workspace/db/gcp-database-secret";

const originalEnvironment = {
  APP_ENV: process.env.APP_ENV,
  NODE_ENV: process.env.NODE_ENV,
  SUPABASE_DATABASE_URL_DEV: process.env.SUPABASE_DATABASE_URL_DEV,
  SUPABASE_DATABASE_URL: process.env.SUPABASE_DATABASE_URL,
  SUPABASE_PG_URL: process.env.SUPABASE_PG_URL,
  DATABASE_URL: process.env.DATABASE_URL,
};

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("database URL resolution", () => {
  it("does not fall back to the generic Replit database URL", () => {
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "development";
    delete process.env.SUPABASE_DATABASE_URL_DEV;
    delete process.env.SUPABASE_DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://replit-user:password@replit.example.test:5432/replit";

    expect(getDatabaseUrl()).toBeUndefined();
  });

  it("uses the development Supabase database URL", async () => {
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "development";
    process.env.SUPABASE_DATABASE_URL_DEV =
      "postgresql://dev_user:dev_password@db.example.test:5432/dev";
    delete process.env.SUPABASE_DATABASE_URL;

    await expect(resolveDatabaseUrl()).resolves.toBe(
      "postgresql://dev_user:dev_password@db.example.test:5432/dev",
    );
  });

  it("uses the production Supabase database URL", async () => {
    process.env.APP_ENV = "production";
    process.env.NODE_ENV = "production";
    process.env.SUPABASE_DATABASE_URL =
      "postgres://prod_user:prod_password@db.example.test:5432/prod";
    delete process.env.SUPABASE_DATABASE_URL_DEV;

    await expect(resolveDatabaseUrl()).resolves.toBe(
      "postgres://prod_user:prod_password@db.example.test:5432/prod",
    );
  });

  it("extracts the environment-specific key from a GCP secret payload", () => {
    const secret = JSON.stringify({
      SUPABASE_DATABASE_URL_DEV:
        "postgresql://dev_user:dev_password@db.example.test:5432/dev",
      SUPABASE_DATABASE_URL:
        "postgres://prod_user:prod_password@db.example.test:5432/prod",
    });

    expect(extractDatabaseUrl(secret, "SUPABASE_DATABASE_URL_DEV")).toBe(
      "postgresql://dev_user:dev_password@db.example.test:5432/dev",
    );
    expect(extractDatabaseUrl(secret, "SUPABASE_DATABASE_URL")).toBe(
      "postgres://prod_user:prod_password@db.example.test:5432/prod",
    );
  });

  it("rejects non-Postgres protocols", () => {
    expect(() =>
      validateDatabaseUrl("https://db.example.test/database", "test source"),
    ).toThrow("test source must be a valid postgres:// or postgresql:// URL");
  });
});