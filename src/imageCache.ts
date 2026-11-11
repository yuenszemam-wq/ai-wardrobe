/** Bounded shared loader. Visible thumbnails coalesce into batches; HD has a separate two-slot queue. */
const memory=new Map<string,Blob>(), pending=new Map<string,{resolve:(b:Blob)=>void;reject:(e:Error)=>void}>();
const flights=new Map<string,Promise<Blob>>();
let timer:ReturnType<typeof setTimeout>|undefined, active=0, epoch=0;
const CACHE='aw-private-thumbs-v1';
export async function refreshImageCache(){clearImageMemory();try{await caches.delete(CACHE);}catch{}window.dispatchEvent(new Event('aw:refresh-images'));}
export function clearImageMemory() { epoch++;memory.clear();flights.clear();for(const p of pending.values())p.reject(new Error('圖片快取已清除'));pending.clear(); }
if(typeof window!=='undefined') { window.addEventListener('aw:unauthorized',clearImageMemory);window.addEventListener('aw:refresh-images',clearImageMemory); }
function remember(id:string,b:Blob) { memory.delete(id);memory.set(id,b);while(memory.size>64)memory.delete(memory.keys().next().value!); }
export function imageIdOf(src?:string) { return src?.match(/^\/api\/images\/(img_[a-z2-7]+)(?:\?|$)/)?.[1]; }
const key=(id:string)=>'/api/thumbnails/'+id;
async function cached(id:string) { try { return await (await caches.open(CACHE)).match(key(id)); } catch { return undefined; } }
async function persist(id:string,blob:Blob,version:string,runEpoch:number) {
  if(epoch!==runEpoch) return;
  try {
    const c=await caches.open(CACHE);
    await c.put(key(id),new Response(blob,{headers:{'content-type':'image/webp','x-aw-cached-at':String(Date.now()),'x-thumbnail-version':version}}));
    if(epoch!==runEpoch) { await c.delete(key(id));return; }
    const keys=await c.keys();for(const old of keys.slice(0,Math.max(0,keys.length-256))) await c.delete(old);
  } catch { /* Storage eviction/private browsing must not prevent display. */ }
}
function schedule() { if(!timer) timer=setTimeout(()=>{timer=undefined;void flush();},24); }
async function flush() {
  if(active>=2||!pending.size)return;
  const entries=[...pending.entries()].slice(0,16);entries.forEach(([id])=>pending.delete(id));
  const runEpoch=epoch;active++;
  try {
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
    let res:Response;
    try {res=await fetch('/api/thumbnails?data=1&ids='+entries.map(([id])=>id).join(','),{credentials:'same-origin',signal:controller.signal});}finally{clearTimeout(timeout);}
    if(!res.ok) { if(res.status===401)window.dispatchEvent(new Event('aw:unauthorized'));throw new Error(`縮圖讀取失敗（${res.status}）`); }
    const data=await res.json() as {items:Array<{image_id:string;base64:string;version:string}>};
    if(epoch!==runEpoch)throw new Error('圖片快取已清除');
    for(const [id,p] of entries) {
      const item=data.items.find((i:{image_id:string})=>i.image_id===id);
      if(!item) { p.reject(new Error('縮圖準備中'));continue; }
      const bytes=Uint8Array.from(atob(item.base64),(c)=>c.charCodeAt(0));
      const blob=new Blob([bytes],{type:'image/webp'});remember(id,blob);void persist(id,blob,item.version,runEpoch);p.resolve(blob);
    }
  } catch(e) {
    for(const [id,p] of entries) {
      const old=epoch===runEpoch?await cached(id):undefined;
      if(old)p.resolve(await old.blob());else p.reject(e as Error);
    }
  } finally { active--;if(pending.size)schedule(); }
}
export function thumbnailBlob(id:string):Promise<Blob> {
  const hit=memory.get(id);if(hit)return Promise.resolve(hit);
  const existing=flights.get(id);if(existing)return existing;
  const p=(async()=>{
    const hit=await cached(id);
    if(hit&&(!navigator.onLine||Date.now()-Number(hit.headers.get('x-aw-cached-at'))<3600000)) {
      const blob=await hit.blob();remember(id,blob);return blob;
    }
    return new Promise<Blob>((resolve,reject)=>{pending.set(id,{resolve,reject});schedule();});
  })();
  flights.set(id,p);p.finally(()=>flights.delete(id)).catch(()=>{});return p;
}
let hdActive=0;
const hdWaiters:Array<()=>void>=[];
export async function highResolutionBlob(src:string):Promise<Blob> {
  if(hdActive>=2)await new Promise<void>(r=>hdWaiters.push(r));
  else hdActive++;
  try {
    for(let attempt=0;attempt<2;attempt++) {
      try {
        const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),25000);
        try {
          const res=await fetch(src,{credentials:'same-origin',signal:controller.signal});
          if(!res.ok) { const error=new Error(`高清圖片讀取失敗（${res.status}）`);if(res.status<500)throw Object.assign(error,{permanent:true});throw error; }
          if(!res.headers.get('content-type')?.startsWith('image/'))throw Object.assign(new Error('圖片格式不正確'),{permanent:true});
          return await res.blob();
        } finally {clearTimeout(timeout);}
      } catch(e) { if(attempt|| (e as {permanent?:boolean}).permanent)throw e;await new Promise(r=>setTimeout(r,450)); }
    }
    throw new Error('高清圖片讀取失敗');
  } finally { const next=hdWaiters.shift();if(next)next();else hdActive--; }
}
/** Export has no thumbnail fallback. Caller must fail the entire export if this throws. */
export async function loadHighResolution(src:string):Promise<HTMLImageElement> {
  const blob=await highResolutionBlob(src),url=URL.createObjectURL(blob);
  try {const img=new Image();img.src=url;await img.decode();return img;} finally {URL.revokeObjectURL(url);}
}
