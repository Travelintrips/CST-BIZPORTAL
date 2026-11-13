import { compressImageFile } from "../../shared/object-storage-web/compressImage";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MIN_COMPRESS_BYTES = 128 * 1024;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Reuse the existing image compressor for HRD pas foto only.
 * Identity documents (KTP, SIM, KK, etc.) continue to use their exact originals
 * for OCR, audit and SHA-256 duplicate detection.
 *
 * Fail open to the original photo if the browser cannot compress, the result is
 * invalid, or the output is not at least 15% smaller. No storage upload occurs here.
 */
export async function optimizeHrdPhotoBeforeUpload(original: File): Promise<File> {
  if (!original || !IMAGE_MIMES.has(original.type) ||
      original.size < MIN_COMPRESS_BYTES || original.size > MAX_PHOTO_BYTES) {
    return original;
  }
  try {
    const candidate = await compressImageFile(original, "photo");
    if (!candidate || !IMAGE_MIMES.has(candidate.type) ||
        candidate.size <= 0 || candidate.size > MAX_PHOTO_BYTES ||
        candidate.size > original.size * 0.85) {
      return original;
    }
    return candidate;
  } catch {
    // A browser without Canvas / image decoding support must retain the
    // already-working private signed-upload path.
    return original;
  }
}
