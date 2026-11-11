// npm run build, then node test/studio-upload-ui.mjs (Playwright + sharp required).
// All data lives in the in-memory test harness; no production services are contacted.
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { makeEnv } from './harness.mjs';
const require = createRequire(import.meta.url);
const deps = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
const { chromium } = require(deps ? `${deps}/playwright` : 'playwright');
const sharp = require(deps ? `${deps}/sharp` : 'sharp');
mkdirSync('test/.tmp', { recursive: true });
await build({ target: "es2022", loader: { ".wasm": "binary" }, entryPoints: ['worker/index.ts'], bundle: true, format: 'esm', platform: 'neutral', outfile: 'test/.tmp/ui-worker.mjs' });
const worker = (await import('./.tmp/ui-worker.mjs')).default;
const env = makeEnv();
const originalLog = console.log;
console.log = (...args) => { if (!String(args[0]).startsWith('{"m"')) originalLog(...args); };
const hash = async (bytes) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hash(new TextEncoder().encode('TEST-UI-SETUP-1234')), new Date().toISOString()).run();
const auth = await worker.fetch(new Request('http://localhost/api/auth/setup', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ code:'TEST-UI-SETUP-1234', username:'tester', password:'test-password-1234' })}), env);
assert.equal(auth.status, 200);
const sessionCookie = auth.headers.get('set-cookie').split(';')[0];
const server = createServer(async (req,res) => {
  try {
    if (!req.url.startsWith('/api/')) {
      const path = req.url.startsWith('/assets/') ? `dist${req.url}` : 'dist/index.html';
      res.setHeader('content-type', path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'application/javascript' : 'text/html');
      res.end(readFileSync(path)); return;
    }
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const bytes=Buffer.concat(chunks);
    const response=await worker.fetch(new Request(`http://localhost${req.url}`,{method:req.method,headers:req.headers,body:bytes.length?bytes:undefined}),env);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  } catch(e) { res.writeHead(500);res.end(String(e)); }
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),args:['--no-sandbox']});
try {
 const context=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true,deviceScaleFactor:1});
 const [cookieName,...cookieValue]=sessionCookie.split('=');
 await context.addCookies([{name:cookieName,value:cookieValue.join('='),url:origin}]);
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.route('https://fonts.googleapis.com/**',r=>r.abort());
 await page.goto(`${origin}/import`);
 const image=async(color,opaque=false)=>sharp({create:{width:240,height:320,channels:4,background:{r:255,g:255,b:255,alpha:opaque?1:0}}}).composite([{input:{create:{width:100,height:180,channels:4,background:color}},left:70,top:60}]).png().toBuffer();
 const a=await image({r:110,g:30,b:120,alpha:1}),b=await image({r:20,g:100,b:160,alpha:1}),c=await image({r:30,g:140,b:90,alpha:1});
 await page.locator('input[type=file]').setInputFiles([{name:'a.png',mimeType:'image/png',buffer:a},{name:'b.png',mimeType:'image/png',buffer:b},{name:'c.png',mimeType:'image/png',buffer:c}]);
 await page.waitForFunction(()=>document.querySelectorAll('[data-merge-id]').length===3 && !Array.from(document.querySelectorAll('button')).find(x=>x.textContent.includes('拖拉合併') && x.disabled));
 assert.ok(page.url().endsWith('/import'),'Upload stays on grouping page');
 const rows=page.locator('[data-merge-id]');
 const source=await rows.nth(0).getAttribute('data-merge-id'),target=await rows.nth(1).getAttribute('data-merge-id');
 // Dispatch real browser touch input through CDP, exercising pointer capture on mobile.
 await rows.nth(1).scrollIntoViewIfNeeded();
 const from=await rows.nth(0).getByRole('button',{name:/拖拉合併/}).boundingBox();const to=await rows.nth(1).boundingBox();
 const client=await context.newCDPSession(page);
 const send=(type,x,y)=>client.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y,id:1}]});
 await send('touchStart',from.x+from.width/2,from.y+from.height/2);
 await send('touchMove',to.x+to.width/2,to.y+20);
 await send('touchEnd',0,0);
 await page.waitForFunction(()=>document.querySelectorAll('[data-merge-id]').length===2);
 assert.equal((await env.DB.prepare('SELECT ai_status FROM garments WHERE id=?').bind(target).first()).ai_status,'pending_ai');
 assert.equal(await env.DB.prepare('SELECT id FROM garments WHERE id=?').bind(source).first(),null);
 assert.ok(await page.getByText('共 2 張').isVisible());
 // Accessible tap alternative and cancellation never silently merge.
 await page.getByRole('button',{name:'選取合併',exact:true}).first().click();
 await page.getByRole('button',{name:'取消選取',exact:true}).click();
 assert.equal(await rows.count(),2);
 await page.getByRole('button',{name:'選取合併',exact:true}).first().click();
 await page.getByRole('button',{name:'合併到這件',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('[data-merge-id]').length===1);
 assert.ok(await page.getByText('共 3 張').isVisible());
 await page.screenshot({path:'test/.tmp/upload-mobile.png',fullPage:true});
 const gid=await rows.first().getAttribute('data-merge-id');
 await env.DB.prepare("UPDATE garments SET status='active' WHERE id=?").bind(gid).run();
 // Add a fully opaque RGBA candidate: metadata says alpha, pixel check must still hide it.
 const badId='opaque-test',badImage='opaque-image';const opaque=await image({r:20,g:20,b:20,alpha:1},true);
 await env.DB.prepare("INSERT INTO garments (id,name,status,source,created_at,updated_at) VALUES (?,?,'active','test',?,?)").bind(badId,'不透明測試',new Date().toISOString(),new Date().toISOString()).run();
 await env.IMAGES.put('opaque.png',opaque,{httpMetadata:{contentType:'image/png'}});
 await env.DB.prepare("INSERT INTO garment_images (id,garment_id,image_type,r2_key,mime_type,width,height,file_size,sha256,has_alpha,is_primary,created_at) VALUES (?,?,'processed','opaque.png','image/png',240,320,?,?,1,1,?)").bind(badImage,badId,opaque.length,await hash(opaque),new Date().toISOString()).run();
 const outfit=await worker.fetch(new Request('http://localhost/api/outfits',{method:'POST',headers:{cookie:sessionCookie,'content-type':'application/json','x-requested-with':'ai-wardrobe'},body:JSON.stringify({name:'透明穿搭',items:[{garment_id:gid,x:10,y:10,w:70,h:70},{garment_id:badId,x:20,y:20,w:50,h:50}]})}),env);
 const outfitData=await outfit.json();assert.equal(outfit.status,200);
 await page.goto(`${origin}/outfits`);
 await page.waitForFunction(()=>document.querySelectorAll('main img').length>=1);
 assert.equal(await page.locator(`img[src*="${badImage}"]`).count(),0,'Opaque RGBA never shown');
 await page.screenshot({path:'test/.tmp/outfits-mobile.png',fullPage:true});
 await page.goto(`${origin}/outfits/${outfitData.id}`);
 await page.waitForFunction(()=>document.querySelectorAll('main img').length>=1);
 assert.equal(await page.locator(`img[src*="${badImage}"]`).count(),0);
 await page.screenshot({path:'test/.tmp/studio-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('PASS: mobile upload, touch drag merge, tap merge/cancel, pending AI status, transparent-only list/studio, no runtime errors');
} finally {await browser.close();server.close();}
