import { afterEach, describe, expect, it } from "vitest";
import { getDatabaseUrl, resolveDatabaseUrl } from "@workspace/db/connection";
import {
  extractDatabaseUrl,
  validateDatabaseUrl,
} from "@workspace/db/gcp-database-secret";

const DEV_REF = "xssrfshdrtdfupgqwfdw";
const PROD_REF = "nzdweipzckfszczzqtuw";

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
  it("does not fall back to the generic database URL", () => {
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "development";
    delete process.env.SUPABASE_DATABASE_URL_DEV;
    delete process.env.SUPABASE_DATABASE_URL;
    delete process.env.SUPABASE_PG_URL;
    process.env.DATABASE_URL =
      "postgresql://replit-user:password@replit.example.test:5432/replit";

    expect(getDatabaseUrl()).toBeUndefined();
  });

  it("requires APP_ENV instead of inferring from NODE_ENV", () => {
    delete process.env.APP_ENV;
    process.env.NODE_ENV = "production";
    process.env.SUPABASE_DATABASE_URL =
      `postgresql://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres`;

    expect(() => getDatabaseUrl()).toThrow(
      'APP_ENV is required and must be explicitly set to "development" or "production"',
    );
  });

  it("uses the development Supabase database URL", async () => {
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "development";
    process.env.SUPABASE_DATABASE_URL_DEV =
      `postgresql://postgres:pw@db.${DEV_REF}.supabase.co:5432/postgres`;
    process.env.SUPABASE_DATABASE_URL =
      `postgresql://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres`;

    await expect(resolveDatabaseUrl()).resolves.toContain(DEV_REF);
  });

  it("keeps DEV routing when the host runs an optimized production build", async () => {
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "production";
    process.env.SUPABASE_DATABASE_URL_DEV =
      `postgresql://postgres:pw@db.${DEV_REF}.supabase.co:5432/postgres`;
    process.env.SUPABASE_DATABASE_URL =
      `postgresql://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres`;

    await expect(resolveDatabaseUrl()).resolves.toContain(DEV_REF);
  });

  it("uses the production Supabase database URL", async () => {
    process.env.APP_ENV = "production";
    process.env.NODE_ENV = "production";
    process.env.SUPABASE_DATABASE_URL =
      `postgresql://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres`;
    process.env.SUPABASE_DATABASE_URL_DEV =
      `postgresql://postgres:pw@db.${DEV_REF}.supabase.co:5432/postgres`;

    await expect(resolveDatabaseUrl()).resolves.toContain(PROD_REF);
  });

  it("rejects DEV runtime pointed at PROD Supabase", async () => {
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "production";
    process.env.SUPABASE_DATABASE_URL_DEV =
      `postgresql://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres`;

    await expect(resolveDatabaseUrl()).rejects.toThrow(
      "points to the opposite environment Supabase project",
    );
  });

  it("rejects PROD runtime pointed at DEV Supabase", async () => {
    process.env.APP_ENV = "production";
    process.env.NODE_ENV = "production";
    process.env.SUPABASE_DATABASE_URL =
      `postgresql://postgres:pw@db.${DEV_REF}.supabase.co:5432/postgres`;

    await expect(resolveDatabaseUrl()).rejects.toThrow(
      "points to the opposite environment Supabase project",
    );
  });

  it("supports Supabase pooler URLs by checking the username project ref", async () => {
    process.env.APP_ENV = "development";
    process.env.NODE_ENV = "production";
    process.env.SUPABASE_DATABASE_URL_DEV =
      `postgresql://postgres.${DEV_REF}:pw@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres`;

    await expect(resolveDatabaseUrl()).resolves.toContain(DEV_REF);
  });

  it("rejects an unsupported APP_ENV instead of guessing a database", () => {
    process.env.APP_ENV = "staging";
    process.env.NODE_ENV = "production";

    expect(() => getDatabaseUrl()).toThrow(
      'Unsupported APP_ENV="staging". Expected "development" or "production".',
    );
  });

  it("extracts the environment-specific key from a GCP secret payload", () => {
    const secret = JSON.stringify({
      SUPABASE_DATABASE_URL_DEV:
        `postgresql://postgres:pw@db.${DEV_REF}.supabase.co:5432/postgres`,
      SUPABASE_DATABASE_URL:
        `postgresql://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres`,
    });

    expect(extractDatabaseUrl(secret, "SUPABASE_DATABASE_URL_DEV")).toContain(
      DEV_REF,
    );
    expect(extractDatabaseUrl(secret, "SUPABASE_DATABASE_URL")).toContain(
      PROD_REF,
    );
  });

  it("rejects non-Postgres protocols", () => {
    expect(() =>
      validateDatabaseUrl("https://db.example.test/database", "test source"),
    ).toThrow("test source must be a valid postgres:// or postgresql:// URL");
  });
});
