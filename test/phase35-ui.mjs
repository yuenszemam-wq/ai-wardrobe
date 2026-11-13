// Browser pixels + recovery regression; CI Chromium emulates phone dimensions, not real iPhone Safari.
import { checker, startRoom, svgPng } from './doll-room.mjs';
const {check,done}=checker();
const R=await startRoom({name:'p35',garments:[{id:'gar_seed',name:'基準衣物',category:'連身裙',subcategory:'OP',png:await svgPng('<rect x="200" y="200" width="500" height="800" fill="#5b2491"/>')}]});
const {page,env,ready,room}=R;
const canvas=()=>page.locator('[data-testid="doll-canvas"]').evaluate(c=>c.toDataURL());
try {
  // All cards point to D1 thumbnails; list loading must not preload HD garment pixels.
  for(let i=0;i<206;i++) {
    const id='gar_many_'+i, image='img_'+i.toString(32).replace(/[0-9a-v]/g,c=>'abcdefghijklmnopqrstuvwxyz234567'[parseInt(c,32)]).padStart(8,'z');
    await env.DB.prepare("INSERT INTO garments (id,name,category,subcategory,status,created_at,updated_at) VALUES (?,?, '上衣', '第206件', 'active','t','t')").bind(id,`衣物${String(i).padStart(3,'0')}`).run();
    await env.DB.prepare("INSERT INTO garment_images (id,garment_id,image_type,r2_key,mime_type,width,height,file_size,sha256,has_alpha,is_primary,created_at) SELECT ?,?,'processed',?,mime_type,width,height,file_size,sha256,1,1,'t' FROM garment_images WHERE garment_id='gar_seed'").bind(image,id,`garments/${id}/p.png`).run();
    await env.DB.prepare("INSERT INTO garment_thumbnails (image_id,garment_id,data,mime_type,byte_size,width,height,has_alpha,source_sha256,version,updated_at) SELECT ?,?,data,mime_type,byte_size,width,height,has_alpha,source_sha256,version,updated_at FROM garment_thumbnails WHERE garment_id='gar_seed'").bind(image,id).run();
  }
  let hd=0;page.on('request',req=>{if(/\/api\/images\/[^/?]+(?:\?|$)/.test(req.url())&&!/thumb/.test(req.url()))hd++;});
  await page.goto(R.base+'/dressing/setup');
  await page.waitForFunction(()=>document.querySelectorAll('[data-setup-garment]').length===207);
  check('setup lists 207 garments',await page.locator('[data-setup-garment]').count()===207);
  check('metadata overview does not fetch HD images',hd===0,hd);
  await page.click('[aria-label="搜尋衣物"]');await page.fill('[aria-label="搜尋衣服名稱"]','衣物205');
  check('search finds garment beyond first page',await page.locator('[data-setup-garment="gar_many_205"]').count()===1);
  await page.goto(R.base+'/dressing');
  await page.waitForSelector('[data-garment="gar_seed"]');await page.click('[data-garment="gar_seed"]');await ready();
  await page.fill('[data-testid="look-name"]','未保存恢復測試');
  await page.waitForTimeout(1100);
  const before=await canvas();
  await page.reload();await page.waitForFunction(()=>document.querySelector('[data-testid="dressing-room"]')?.dataset.worn==='gar_seed');await ready();
  check('draft restores unsaved clothes and name',await room('data-worn')==='gar_seed' && await page.inputValue('[data-testid="look-name"]')==='未保存恢復測試');
  check('restored canvas pixels equal pre-reload canvas',await canvas()===before);
  check('draft never creates a formal look',(await env.DB.prepare('SELECT COUNT(*) AS n FROM doll_looks').first()).n===0);
  // Per-part colors are tested with the same source texture, ensuring cache isolation.
  await page.click('[data-tab="look"]');await page.click('[data-looktab="color"]');
  const options=await page.locator('[data-testid="hair-color-target"] option').evaluateAll(os=>os.map(o=>o.value).filter(Boolean));
  await page.selectOption('[data-testid="hair-color-target"]',options[0]);
  const hex=page.locator('[data-testid="color-hex"]');
  await hex.fill('#ff3377');await hex.press('Enter');await page.waitForTimeout(250);await ready();
  const red=await canvas();
  await page.selectOption('[data-testid="hair-color-target"]',options[1]);await hex.fill('#3355ff');await hex.press('Enter');await page.waitForTimeout(250);await ready();
  check('second part color changes actual canvas pixels independently',await canvas()!==red);
  await page.waitForTimeout(1000);await page.reload();await ready();
  await page.click('[data-tab="look"]');await page.click('[data-looktab="color"]');
  await page.selectOption('[data-testid="hair-color-target"]',options[0]);
  check('first hair part override survives recovery',await hex.inputValue()==='#ff3377');
  await page.selectOption('[data-testid="hair-color-target"]',options[1]);
  check('second hair part override survives recovery',await hex.inputValue()==='#3355ff');
  check('no browser errors',R.errors.length===0,R.errors);
} catch(e){check('browser regression interrupted: '+e.message,false);console.log(e.stack);}
finally{await R.close();done();}
