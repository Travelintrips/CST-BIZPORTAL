import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hrdPrivateStorageReady, validPhotoMime, validPhotoBytes,
  createHrdPhotoSignedUpload, photoSha256,
} from "./hrd-photo-storage";

const saved = {
  app: process.env.APP_ENV,
  enabled: process.env.HRD_PROD_DOCUMENTS_ENABLED,
  url: process.env.HRD_PROD_SUPABASE_URL,
  key: process.env.HRD_PROD_STORAGE_SERVICE_KEY,
};
const restore = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
};
afterEach(() => {
  restore("APP_ENV", saved.app);
  restore("HRD_PROD_DOCUMENTS_ENABLED", saved.enabled);
  restore("HRD_PROD_SUPABASE_URL", saved.url);
  restore("HRD_PROD_STORAGE_SERVICE_KEY", saved.key);
  vi.unstubAllGlobals();
});
describe("HRD private PROD photo storage", () => {
  it("denies DEV and wrong project, even with a credential", () => {
    process.env.APP_ENV = "development";
    process.env.HRD_PROD_DOCUMENTS_ENABLED = "true";
    process.env.HRD_PROD_SUPABASE_URL = "https://nzdweipzckfszczzqtuw.supabase.co";
    process.env.HRD_PROD_STORAGE_SERVICE_KEY = "synthetic-test-key";
    expect(hrdPrivateStorageReady()).toBe(false);
    process.env.APP_ENV = "production";
    process.env.HRD_PROD_SUPABASE_URL = "https://xssrfshdrtdfupgqwfdw.supabase.co";
    expect(hrdPrivateStorageReady()).toBe(false);
    process.env.HRD_PROD_SUPABASE_URL = "https://nzdweipzckfszczzqtuw.supabase.co";
    expect(hrdPrivateStorageReady()).toBe(true);
  });
  it("rejects unsupported uploads and suspicious image contents", () => {
    expect(validPhotoMime("application/pdf")).toBe(false);
    expect(validPhotoMime("image/svg+xml")).toBe(false);
    expect(validPhotoBytes(Buffer.from("%PDF-1.7"), "image/jpeg")).toBe(false);
    expect(validPhotoBytes(Buffer.from([255,216,255,1,2]),"image/jpeg")).toBe(true);
    expect(validPhotoBytes(Buffer.from([137,80,78,71,13,10,26,10,1]),"image/png")).toBe(true);
    expect(validPhotoBytes(Buffer.alloc(0),"image/png")).toBe(false);
    expect(photoSha256(Buffer.from("fixture"))).toHaveLength(64);
  });
  it("refuses signing under disabled settings before any network request", async () => {
    delete process.env.HRD_PROD_DOCUMENTS_ENABLED;
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(createHrdPhotoSignedUpload("1/2/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg"))
      .rejects.toThrow("HRD_PRIVATE_STORAGE_DISABLED");
    expect(request).not.toHaveBeenCalled();
  });
  it("extracts Supabase token from signed-upload URL without disclosing service key", async () => {
    process.env.APP_ENV = "production";
    process.env.HRD_PROD_DOCUMENTS_ENABLED = "true";
    process.env.HRD_PROD_SUPABASE_URL = "https://nzdweipzckfszczzqtuw.supabase.co";
    process.env.HRD_PROD_STORAGE_SERVICE_KEY = "synthetic-test-key";
    const fetcher = vi.fn(async () => ({
      ok: true, json: async () => ({url:"/storage/v1/object/upload/sign/bizportal-hrd-documents-prod/1/2/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg?token=synthetic-token"}),
    }));
    vi.stubGlobal("fetch", fetcher);
    const signed = await createHrdPhotoSignedUpload("1/2/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg");
    expect(signed.token).toBe("synthetic-token");
    expect(signed.path).toBe("1/2/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg");
    expect(JSON.stringify(signed)).not.toContain("synthetic-test-key");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
