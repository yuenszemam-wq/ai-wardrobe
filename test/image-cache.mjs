import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
class Cache {
 constructor(){this.m=new Map();}
 key(k){return typeof k==='string'?k:k.url;}
 async match(k){return this.m.get(this.key(k))?.clone();}
 async put(k,v){this.m.set(this.key(k),v.clone());}
 async keys(){return [...this.m.keys()].map(url=>({url}));}
 async delete(k){return this.m.delete(this.key(k));}
}
const stores=new Map();const caches={open:async name=>{if(!stores.has(name))stores.set(name,new Cache());return stores.get(name);},keys:async()=>[...stores.keys()],delete:async name=>stores.delete(name),match:async key=>{for(const c of stores.values()){const r=await c.match(key);if(r)return r;}}};
globalThis.caches=caches;Object.defineProperty(globalThis,'navigator',{value:{onLine:true},configurable:true});
let requests=0,concurrency=0,max=0;
globalThis.fetch=async url=>{requests++;concurrency++;max=Math.max(max,concurrency);await new Promise(r=>setTimeout(r,4));concurrency--;const ids=new URL(url,'https://test').searchParams.get('ids').split(',');return Response.json({items:ids.map(image_id=>({image_id,version:'test',base64:Buffer.from('webp').toString('base64')}))});};
await build({entryPoints:['src/imageCache.ts'],bundle:true,platform:'node',format:'esm',target:'es2022',outfile:'test/.tmp/image-cache.mjs'});
const loader=await import('./.tmp/image-cache.mjs');
const ids=Array.from({length:40},(_,i)=>'img_'+String.fromCharCode(97+i));
await Promise.all(ids.flatMap(id=>[loader.thumbnailBlob(id),loader.thumbnailBlob(id)]));
assert.equal(requests,3);assert.ok(max<=2);console.log('✓ 80 rapid-scroll consumers coalesce into 3 batches, max 2 concurrent');
await new Promise(r=>setTimeout(r,50));loader.clearImageMemory();navigator.onLine=false;
const previous=requests;assert.equal(await(await loader.thumbnailBlob(ids[0])).text(),'webp');assert.equal(requests,previous);console.log('✓ offline restart uses persisted thumbnail without network');
loader.clearImageMemory();navigator.onLine=true;globalThis.fetch=async()=>new Response('unavailable',{status:503});
await assert.rejects(()=>loader.highResolutionBlob('/api/images/img_test'));console.log('✓ HD failures throw; export cannot receive low-resolution fallback');
// Phase 3.8：重新整理只核對版本，不刪除縮圖庫；只下載版本已改變的縮圖
{
  navigator.onLine=true;loader.clearImageMemory();
  const log=[];let version='test';
  globalThis.fetch=async url=>{const u=new URL(url,'https://test');log.push(u.searchParams.get('data')==='1'?'data':'meta');const ids=u.searchParams.get('ids').split(',');return Response.json({items:ids.map(image_id=>({image_id,version:image_id===ids[0]?version:'test',base64:Buffer.from('new').toString('base64')}))});};
  globalThis.window={dispatchEvent(){},addEventListener(){}};
  await loader.refreshImageCache();
  version='changed';
  const got=await Promise.all(ids.slice(0,16).map(id=>loader.thumbnailBlob(id)));
  assert.deepEqual(log,['meta','data'],log);
  assert.equal(await got[0].text(),'new');assert.equal(await got[1].text(),'webp');
  console.log('✓ pull-to-refresh: version check only, downloads 1 changed thumbnail, keeps 15 unchanged');
  assert.ok((await caches.keys()).includes('aw-private-thumbs-v1'));console.log('✓ refresh no longer deletes the thumbnail store');
  // 高清：第二次讀取使用手機已保存的高清圖
  let hd=0;globalThis.fetch=async()=>{hd++;return new Response(new Blob(['hd-bytes']),{headers:{'content-type':'image/png'}});};
  const a=loader.highResolutionBlob('/api/images/img_hd'),b=loader.highResolutionBlob('/api/images/img_hd');
  assert.equal(await (await a).text(),'hd-bytes');await b;assert.equal(hd,1);
  await new Promise(r=>setTimeout(r,20));loader.clearImageMemory();
  assert.equal(await (await loader.highResolutionBlob('/api/images/img_hd')).text(),'hd-bytes');assert.equal(hd,1);
  console.log('✓ HD: duplicate requests merge; cached HD reused without another R2 read');
  delete globalThis.window;
}
// Phase 3.8A.2：清除快取如實回報、指定保留的高清圖、舊下載不會寫回、共用下載的取消互不影響
{
  globalThis.window={dispatchEvent(){},addEventListener(){}};
  loader.clearImageMemory();
  globalThis.fetch=async()=>new Response(new Blob(['hd2']),{headers:{'content-type':'image/png'}});
  await loader.highResolutionBlob('/api/images/img_keep',{pin:true});
  await loader.highResolutionBlob('/api/images/img_drop');
  await new Promise(r=>setTimeout(r,20));
  const r1=await loader.clearImageCaches({thumbs:false,hd:true});
  assert.equal(r1.hd.count,2,JSON.stringify(r1));assert.equal(r1.keptPinned,1);assert.equal(r1.errors.length,0);
  const hdStore=await caches.open('aw-private-hd-v1');
  assert.ok(await hdStore.match('/api/images/img_keep'));assert.ok(!(await hdStore.match('/api/images/img_drop')));
  console.log('✓ clear HD: reports count, keeps pinned offline images unless chosen');
  const r2=await loader.clearImageCaches({thumbs:true,hd:true,includePinned:true});
  assert.ok(!(await hdStore.match('/api/images/img_keep')));assert.ok(r2.thumbs.count>0);
  console.log('✓ clear all incl. pinned: thumbs and pinned HD removed, counts reported');
  // 清除時仍在下載的舊請求：完成後不會寫回快取
  let release;globalThis.fetch=()=>new Promise(r=>{release=()=>r(new Response(new Blob(['late']),{headers:{'content-type':'image/png'}}));});
  const late=loader.highResolutionBlob('/api/images/img_late');late.catch(()=>{});
  await new Promise(r=>setTimeout(r,5));
  await loader.clearImageCaches({thumbs:true,hd:true});
  release?.();await new Promise(r=>setTimeout(r,20));
  assert.ok(!(await (await caches.open('aw-private-hd-v1')).match('/api/images/img_late')));
  console.log('✓ in-flight download finishing after clear/logout does not re-populate the cache');
  // 共用下載：其中一個元件取消，不影響另一個
  let calls=0,finish;globalThis.fetch=(u,o)=>new Promise((r,j)=>{calls++;o?.signal?.addEventListener('abort',()=>j(new DOMException('aborted','AbortError')));finish=()=>r(new Response(new Blob(['shared']),{headers:{'content-type':'image/png'}}));});
  const c1=new AbortController();
  const p1=loader.highResolutionBlob('/api/images/img_share',{signal:c1.signal}),p2=loader.highResolutionBlob('/api/images/img_share');p1.catch(()=>{});
  await new Promise(r=>setTimeout(r,5));c1.abort();
  await assert.rejects(p1);finish();
  assert.equal(await (await p2).text(),'shared');assert.equal(calls,1);
  console.log('✓ shared HD flight: one consumer cancelling does not cancel the others');
  const c2=new AbortController(),c3=new AbortController();let aborted=false;
  globalThis.fetch=(u,o)=>new Promise((r,j)=>{o?.signal?.addEventListener('abort',()=>{aborted=true;j(new DOMException('aborted','AbortError'));});});
  const q1=loader.highResolutionBlob('/api/images/img_both',{signal:c2.signal}),q2=loader.highResolutionBlob('/api/images/img_both',{signal:c3.signal});q1.catch(()=>{});q2.catch(()=>{});
  await new Promise(r=>setTimeout(r,5));c2.abort();await new Promise(r=>setTimeout(r,5));assert.equal(aborted,false);c3.abort();
  await Promise.allSettled([q1,q2]);await new Promise(r=>setTimeout(r,5));assert.equal(aborted,true);
  console.log('✓ shared HD flight aborts the network request only when every consumer cancels');
  delete globalThis.window;
}
// Execute the actual service-worker lifecycle against mock caches/network.
const listeners={};let net=true;
const context={self:{addEventListener:(name,fn)=>listeners[name]=fn,skipWaiting:async()=>{},clients:{claim:async()=>{}}},location:{origin:'https://test'},caches,URL,Response,Headers,Promise,fetch:async req=>{if(!net)throw new Error('offline');return Response.json(req.url.endsWith('status')?{logged_in:true}:{items:[{id:'g_1'}]});}};
vm.runInNewContext(readFileSync('public/sw.js','utf8'),context);
async function sw(path,method='GET'){let response;listeners.fetch({request:new Request('https://test'+path,{method}),respondWith:p=>response=p,waitUntil:()=>{}});return response?await response:null;}
await sw('/api/auth/status');await sw('/api/garments');net=false;
assert.equal((await(await sw('/api/auth/status')).json()).logged_in,true);assert.equal((await(await sw('/api/garments')).json()).items[0].id,'g_1');
assert.equal(await sw('/api/tokens'),null);assert.equal(await sw('/api/images/img_aaaa'),null);console.log('✓ offline auth/list reopen; secrets and HD excluded from offline cache');
net=true;await sw('/api/auth/logout','POST');assert.equal((await caches.keys()).filter(k=>k.startsWith('aw-private-')).length,0);console.log('✓ logout removes private data and thumbnail caches');
