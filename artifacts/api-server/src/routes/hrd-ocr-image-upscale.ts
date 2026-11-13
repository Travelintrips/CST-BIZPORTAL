import {PNG} from "pngjs";

// pngjs is pure JavaScript, bundled into the production server.
// No native/image service, no disk write; the original SHA remains unchanged.
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
const MAX_INPUT=5*1024*1024;
const MAX_RESIZED=12*1024*1024;

/** Bounded 4x bilinear in-memory enlargement ONLY for small PNG documents.
 * Malformed/oversized images fail closed to the original OCR behavior. */
export function upscaleLowResolutionPng(bytes:Buffer):Buffer|null{
 if(bytes.length<24||bytes.length>MAX_INPUT||
    !bytes.subarray(0,8).equals(signature))return null;
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
 if(width<24||height<24||width>800||height>800||
    width*height>640000)return null;
 const scale=Math.min(4,Math.floor(2400/Math.max(width,height)));
 if(scale<2)return null;
 try{
  const source=PNG.sync.read(bytes);
  if(source.width!==width||source.height!==height||
     !source.data||source.data.length<width*height*4)return null;
  const enlarged=new PNG({width:width*scale,height:height*scale});
  for(let y=0;y<enlarged.height;y++){
   const sy=(y+0.5)/scale-0.5;
   const iy=Math.floor(sy),y0=Math.max(0,iy),y1=Math.min(height-1,iy+1);
   const fy=Math.max(0,Math.min(1,sy-iy));
   for(let x=0;x<enlarged.width;x++){
    const sx=(x+0.5)/scale-0.5;
    const ix=Math.floor(sx),x0=Math.max(0,ix),x1=Math.min(width-1,ix+1);
    const fx=Math.max(0,Math.min(1,sx-ix));
    const a=(y0*width+x0)*4,b=(y0*width+x1)*4;
    const c=(y1*width+x0)*4,d=(y1*width+x1)*4;
    const offset=(y*enlarged.width+x)*4;
    for(let channel=0;channel<4;channel++){
     const upper=source.data[a+channel]*(1-fx)+source.data[b+channel]*fx;
     const lower=source.data[c+channel]*(1-fx)+source.data[d+channel]*fx;
     enlarged.data[offset+channel]=Math.round(upper*(1-fy)+lower*fy);
    }
   }
  }
  const result=PNG.sync.write(enlarged,{colorType:6}) as Buffer;
  return result.length<=MAX_RESIZED?result:null;
 }catch{return null;}
}
