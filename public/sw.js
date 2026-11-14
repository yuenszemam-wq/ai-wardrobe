const SHELL='aw-shell-v4', DATA='aw-private-data-v1';
let generation=0;
const privateCache=(name)=>name.startsWith('aw-private-');
async function purgePrivate() {generation++;await Promise.all((await caches.keys()).filter(privateCache).map(k=>caches.delete(k)));}
// Phase 3.8B 離線冷啟動：安裝時預先保存 App Shell 及其引用的 JavaScript、CSS、圖示（解析首頁 HTML），
// 令手機沒有網絡時仍可由主畫面開啟 PWA。任何一步失敗都退回最基本的首頁快取，不會令安裝失敗。
async function precache(){
  const c=await caches.open(SHELL);
  try{
    const res=await fetch('/',{cache:'no-store'});
    if(!res.ok)throw new Error('shell');
    await c.put('/',res.clone());
    const html=await res.text();
    const urls=[...html.matchAll(/(?:src|href)="(\/(?:assets|icons)\/[^"?#]+)"/g)].map(m=>m[1]);
    await c.addAll([...new Set([...urls,'/manifest.webmanifest'])]);
  }catch{await c.addAll(['/','/manifest.webmanifest']).catch(()=>undefined);}
}
self.addEventListener('install',event=>event.waitUntil(precache().then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('aw-shell-')&&k!==SHELL).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('message',event=>{if(event.data?.type==='CLEAR_PRIVATE')event.waitUntil(purgePrivate());});
// Only non-secret, authenticated display GETs are persisted. Tokens, signed URLs, MCP, uploads and HD are excluded.
const offlinePath=(p)=>/^\/api\/(auth\/status|garments(?:\/[\w-]+)?|stats|taxonomy|settings(?:\/colors)?|outfits(?:\/[\w-]+)?|ai\/review|analysis|doll\/looks)$/.test(p);
self.addEventListener('fetch',event=>{
  const req=event.request,url=new URL(req.url);
  if(url.origin!==location.origin)return;
  if(req.method!=='GET') {
    if(url.pathname==='/api/auth/logout')event.respondWith(purgePrivate().then(()=>fetch(req)));
    return;
  }
  if(offlinePath(url.pathname)&&!req.headers.has('authorization')) {
    const start=generation;
    event.respondWith((async()=>{
      const cache=await caches.open(DATA);
      try {
        const res=await fetch(req);
        let loggedOut=res.status===401;
        if(url.pathname==='/api/auth/status'&&res.ok)loggedOut=!(await res.clone().json()).logged_in;
        if(loggedOut){await purgePrivate();return res;}
        if(res.ok&&start===generation) {
          await cache.put(req,res.clone());
          const keys=await cache.keys();for(const old of keys.slice(0,Math.max(0,keys.length-96)))await cache.delete(old);
        }
        return res;
      } catch(error) {
        const hit=start===generation?await cache.match(req):undefined;
        if(hit) {const h=new Headers(hit.headers);h.set('x-aw-offline','1');return new Response(hit.body,{status:hit.status,headers:h});}
        throw error;
      }
    })());return;
  }
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/mcp'))return;
  if(req.mode==='navigate') {
    event.respondWith(fetch(req).then(async res=>{if(res.ok)await(await caches.open(SHELL)).put('/',res.clone());return res;}).catch(()=>caches.match('/')));return;
  }
  // 內置人物素材（/doll/）亦以快取優先，離線時可以顯示已用過的人物
  if(url.pathname.startsWith('/assets/')||url.pathname.startsWith('/icons/')||url.pathname.startsWith('/doll/'))event.respondWith((async()=>{
    const cache=await caches.open(SHELL),hit=await cache.match(req);if(hit)return hit;
    const res=await fetch(req);if(res.ok)await cache.put(req,res.clone());return res;
  })());
});
