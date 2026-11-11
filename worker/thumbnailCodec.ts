// WASM modules are bundled with the Worker, never downloaded at runtime.
import pngDecode, { init as pngInit } from '@jsquash/png/decode.js';
import jpegDecode, { init as jpegInit } from '@jsquash/jpeg/decode.js';
import webpDecode, { init as webpInit } from '@jsquash/webp/decode.js';
import webpFactory from '@jsquash/webp/codec/enc/webp_enc.js';
import { defaultOptions } from '@jsquash/webp/meta.js';
// @ts-expect-error Wrangler imports WASM as a compiled module (package declaration describes raw exports).
import pngWasm from '@jsquash/png/codec/pkg/squoosh_png_bg.wasm';
import jpegWasm from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm';
import webpWasm from '@jsquash/webp/codec/dec/webp_dec.wasm';
import encoderWasm from '@jsquash/webp/codec/enc/webp_enc.wasm';

// Tests use esbuild's binary loader; production imports precompiled WASM modules.
const moduleOf = async (m: WebAssembly.Module) => m instanceof WebAssembly.Module ? m : WebAssembly.compile(m as BufferSource);
let ready: Promise<any> | undefined;
function init() {
  return ready ??= (async () => {
    const [p,j,w,e] = await Promise.all([pngWasm,jpegWasm,webpWasm,encoderWasm].map(moduleOf));
    await pngInit(p); await jpegInit(j); await webpInit(w);
    return webpFactory({ noInitialRun:true, instantiateWasm(imports: WebAssembly.Imports, cb: (i:WebAssembly.Instance)=>void) {
      const instance = new WebAssembly.Instance(e,imports); cb(instance); return instance.exports;
    }});
  })();
}

/** Area resampling with premultiplied alpha avoids dark/white halos on cutouts. */
export function resizeRGBA(src: ImageData, maxW=240, maxH=300): ImageData {
  const scale=Math.min(1,maxW/src.width,maxH/src.height);
  const width=Math.max(1,Math.round(src.width*scale)), height=Math.max(1,Math.round(src.height*scale));
  const data=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const x0=x*src.width/width,x1=(x+1)*src.width/width,y0=y*src.height/height,y1=(y+1)*src.height/height;
    let a=0,r=0,g=0,b=0,weight=0;
    for(let sy=Math.floor(y0);sy<Math.ceil(y1);sy++) for(let sx=Math.floor(x0);sx<Math.ceil(x1);sx++) {
      const w=(Math.min(x1,sx+1)-Math.max(x0,sx))*(Math.min(y1,sy+1)-Math.max(y0,sy));
      const i=(sy*src.width+sx)*4, aw=w*src.data[i+3];
      weight+=w;a+=aw;r+=src.data[i]*aw;g+=src.data[i+1]*aw;b+=src.data[i+2]*aw;
    }
    const i=(y*width+x)*4;
    data[i]=a?r/a:0;data[i+1]=a?g/a:0;data[i+2]=a?b/a:0;data[i+3]=a/weight;
  }
  return {data,width,height,colorSpace:'srgb'} as ImageData;
}
export async function encodeThumbnail(bytes: Uint8Array, mime: string) {
  const encoder=await init();
  const ab=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;
  const decoded=mime==='image/png'?await pngDecode(ab):mime==='image/jpeg'?await jpegDecode(ab):mime==='image/webp'?await webpDecode(ab):null;
  if(!decoded) throw new Error('unsupported_thumbnail_format');
  for(const size of [1,.8,.64,.5]) {
    const image=resizeRGBA(decoded,Math.round(240*size),Math.round(300*size));
    for(const quality of [82,68,50]) {
      const encoded=encoder.encode(image.data,image.width,image.height,{...defaultOptions,quality,method:3,alpha_quality:100});
      if(!encoded) throw new Error('thumbnail_encode_failed');
      const output=new Uint8Array(encoded);
      if(output.byteLength<=30720) return output;
    }
  }
  throw new Error('thumbnail_too_large');
}
