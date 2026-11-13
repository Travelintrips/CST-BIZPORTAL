// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compressImageFile } from "../../shared/object-storage-web/compressImage";
import { optimizeHrdPhotoBeforeUpload } from "./hrd-photo-compression";
import { buildHrdSignedUploadUrl } from "./hrd-signed-upload";

vi.mock("../../shared/object-storage-web/compressImage", () => ({
  compressImageFile: vi.fn(),
}));

const createPhoto = (size: number, mime = "image/jpeg") =>
  new File([new Uint8Array(size)], "employee-photo.jpg", { type: mime });

beforeEach(() => { vi.resetAllMocks(); });

describe("HRD pas foto optional compression (original identity documents unchanged)", () => {
  it("reuses the existing compressor and signs the optimized WebP extension", async () => {
    const original = createPhoto(400 * 1024);
    const optimized = new File([new Uint8Array(120 * 1024)], "employee-photo.webp", {type:"image/webp"});
    vi.mocked(compressImageFile).mockResolvedValue(optimized);
    const selected = await optimizeHrdPhotoBeforeUpload(original);
    expect(selected).toBe(optimized);
    expect(compressImageFile).toHaveBeenCalledWith(original,"photo");
    expect(buildHrdSignedUploadUrl({
      companyId:1,employeeId:7,
      documentId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      path:"1/7/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp",
      storageUrl:"https://nzdweipzckfszczzqtuw.supabase.co",
      bucket:"bizportal-hrd-documents-prod",token:"synthetic-token",maxBytes:5242880,
    },selected,1,7)).toContain(".webp?token=synthetic-token");
    expect(original.size).toBe(400 * 1024);
    expect(original.type).toBe("image/jpeg");
  });
  it("keeps the original if compression is marginal or makes it bigger",async()=>{
    const original=createPhoto(200*1024);
    vi.mocked(compressImageFile).mockResolvedValue(createPhoto(180*1024));
    expect(await optimizeHrdPhotoBeforeUpload(original)).toBe(original);
    vi.mocked(compressImageFile).mockResolvedValue(createPhoto(205*1024));
    expect(await optimizeHrdPhotoBeforeUpload(original)).toBe(original);
  });
  it("keeps the original when browser compression fails or returns an invalid MIME",async()=>{
    const original=createPhoto(300*1024);
    vi.mocked(compressImageFile).mockRejectedValue(new Error("Canvas unavailable"));
    expect(await optimizeHrdPhotoBeforeUpload(original)).toBe(original);
    vi.mocked(compressImageFile).mockResolvedValue(
      new File([new Uint8Array(40*1024)],"wrong.pdf",{type:"application/pdf"}));
    expect(await optimizeHrdPhotoBeforeUpload(original)).toBe(original);
  });
  it("never compresses small photos, PDFs or oversized rejected files",async()=>{
    const small=createPhoto(100*1024);
    const pdf=createPhoto(200*1024,"application/pdf");
    const over=createPhoto(5*1024*1024+1);
    expect(await optimizeHrdPhotoBeforeUpload(small)).toBe(small);
    expect(await optimizeHrdPhotoBeforeUpload(pdf)).toBe(pdf);
    expect(await optimizeHrdPhotoBeforeUpload(over)).toBe(over);
    expect(compressImageFile).not.toHaveBeenCalled();
  });
});
