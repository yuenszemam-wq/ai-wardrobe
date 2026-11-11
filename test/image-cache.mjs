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
// Execute the actual service-worker lifecycle against mock caches/network.
const listeners={};let net=true;
const context={self:{addEventListener:(name,fn)=>listeners[name]=fn,skipWaiting:async()=>{},clients:{claim:async()=>{}}},location:{origin:'https://test'},caches,URL,Response,Headers,Promise,fetch:async req=>{if(!net)throw new Error('offline');return Response.json(req.url.endsWith('status')?{logged_in:true}:{items:[{id:'g_1'}]});}};
vm.runInNewContext(readFileSync('public/sw.js','utf8'),context);
async function sw(path,method='GET'){let response;listeners.fetch({request:new Request('https://test'+path,{method}),respondWith:p=>response=p,waitUntil:()=>{}});return response?await response:null;}
await sw('/api/auth/status');await sw('/api/garments');net=false;
assert.equal((await(await sw('/api/auth/status')).json()).logged_in,true);assert.equal((await(await sw('/api/garments')).json()).items[0].id,'g_1');
assert.equal(await sw('/api/tokens'),null);assert.equal(await sw('/api/images/img_aaaa'),null);console.log('✓ offline auth/list reopen; secrets and HD excluded from offline cache');
net=true;await sw('/api/auth/logout','POST');assert.equal((await caches.keys()).filter(k=>k.startsWith('aw-private-')).length,0);console.log('✓ logout removes private data and thumbnail caches');
