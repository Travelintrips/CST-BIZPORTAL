// Locally scoped typings for the small subset of pngjs used by HRD OCR.
// Keep dependency pure-JS; avoid adding native image processing to Hostinger.
declare module "pngjs" {
  export class PNG {
    constructor(options: { width: number; height: number });
    width: number;
    height: number;
    data: Buffer;
    static sync: {
      read(bytes: Buffer): PNG;
      write(image: PNG, options?: { colorType?: number }): Buffer;
    };
  }
}
