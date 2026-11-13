import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {describe,expect,it} from "vitest";
import {upscaleLowResolutionPng} from "./hrd-ocr-image-upscale";

const require=createRequire(import.meta.url);
const PNG=require("pngjs").PNG;
function fixture(width=48,height=32){
 const image=new PNG({width,height});
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const i=(y*width+x)*4, v=x<width/2?0:255;
  image.data[i]=v;image.data[i+1]=v;
  image.data[i+2]=v;image.data[i+3]=255;
 }
 return PNG.sync.write(image) as Buffer;
}
describe("HRD bounded low-resolution PNG preprocessor",()=>{
 it("enlarges 4x with bilinear pixels without changing original bytes",()=>{
  const original=fixture();
  const hash=createHash("sha256").update(original).digest("hex");
  const resized=upscaleLowResolutionPng(original);
  expect(resized).not.toBeNull();
  const parsed=PNG.sync.read(resized!);
  expect([parsed.width,parsed.height]).toEqual([192,128]);
  expect(parsed.data.length).toBe(192*128*4);
  expect(createHash("sha256").update(original).digest("hex")).toBe(hash);
 });
 it("fails closed for wrong mime bytes, malformed and oversized dimension headers",()=>{
  expect(upscaleLowResolutionPng(Buffer.from("not an image"))).toBeNull();
  const png=fixture();
  const fake=Buffer.from(png);
  fake.writeUInt32BE(5000,16);
  expect(upscaleLowResolutionPng(fake)).toBeNull();
  const corrupted=Buffer.from(png);
  corrupted[30]=corrupted[30]^0xff;
  expect(upscaleLowResolutionPng(corrupted)).toBeNull();
 });
 it("does not modify normal-sized PNG or amplify excessive image allocations",()=>{
  const large=fixture(850,100);
  expect(upscaleLowResolutionPng(large)).toBeNull();
  const tiny=fixture(12,12);
  expect(upscaleLowResolutionPng(tiny)).toBeNull();
 });
});
