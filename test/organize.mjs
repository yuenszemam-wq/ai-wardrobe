import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeEnv } from './harness.mjs';
mkdirSync('test/.tmp',{recursive:true});
await build({ target: "es2022", loader: { ".wasm": "binary" },entryPoints:['worker/index.ts'],bundle:true,format:'esm',platform:'neutral',outfile:'test/.tmp/organize-worker.mjs'});
const worker=(await import('./.tmp/organize-worker.mjs')).default;
const env=makeEnv();let cookie='',passed=0;
const log=console.log;console.log=(...args)=>{if(!String(args[0]).startsWith('{"m"'))log(...args)};
const check=(name,value)=>{assert.ok(value,name);passed++;log('✓',name)};
const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hash(new TextEncoder().encode('TEST-ORGANIZE-CODE')),new Date().toISOString()).run();
async function call(path,body,authenticated=true){
 const headers={'content-type':'application/json'};if(cookie&&authenticated){headers.cookie=cookie;headers['x-requested-with']='ai-wardrobe'};
 const r=await worker.fetch(new Request('https://test.example'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined}),env);
 if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
 return {status:r.status,data:await r.json()};
}
await call('/api/auth/setup',{code:'TEST-ORGANIZE-CODE',username:'test',password:'testpassword123'});
const a=(await call('/api/garments',{name:'甲',brand:'舊品牌',category:'連身裙',subcategory:'JSK',notes:'保留甲',attributes:{condition:'良好',decoration:['蝴蝶結']}})).data;
const b=(await call('/api/garments',{name:'乙',brand:'其他品牌',category:'半身裙',subcategory:'SK',notes:'保留乙',attributes:{condition:'全新',collection_status:'擁有'}})).data;
await env.DB.prepare("UPDATE garments SET ai_status='pending_ai' WHERE id IN (?,?)").bind(a.id,b.id).run();
let r=await call('/api/garments/bulk-edit',{garment_ids:[a.id,b.id],set:{brand:'統一品牌',attributes:{condition:'待清洗'}}});
check('批量更新兩件',r.data.results.every(x=>x.ok));
let aa=(await call(`/api/garments/${a.id}`)).data,bb=(await call(`/api/garments/${b.id}`)).data;
check('品牌與所選屬性統一',aa.brand==='統一品牌'&&bb.brand==='統一品牌'&&aa.attributes.condition==='待清洗'&&bb.attributes.condition==='待清洗');
check('未勾選的資料各自保留',aa.notes==='保留甲'&&bb.notes==='保留乙'&&aa.attributes.decoration[0]==='蝴蝶結'&&bb.attributes.collection_status==='擁有');
check('批量修改不完成AI辨認',aa.ai_status==='pending_ai'&&bb.ai_status==='pending_ai');
check('人工編輯鎖定及版本更新',aa.locked_fields.includes('brand')&&aa.version>a.version);
r=await call('/api/garments/bulk-edit',{garment_ids:[a.id,b.id],set:{category:'上衣',attributes:{condition:null},brand:null}});
aa=(await call(`/api/garments/${a.id}`)).data;
check('更換主分類清除舊子分類',aa.category==='上衣'&&aa.subcategory===null);
check('可明確清空欄位與單一屬性',aa.brand===null&&!aa.attributes.condition&&aa.attributes.decoration.length===1);
r=await call('/api/garments/bulk-edit',{garment_ids:[a.id,'missing'],set:{notes:'部分成功'}});
check('部分失敗逐件回報',r.data.results[0].ok&&!r.data.results[1].ok);
for(const set of [{confirm:true},{ai_status:'done'},{name:''},{price:-10},{status:''},{category:'不存在的分類'}]){
 r=await call('/api/garments/bulk-edit',{garment_ids:[a.id],set});check('拒絕無效批量欄位 '+JSON.stringify(set),r.status===400);
}
check('批量最多100件',(await call('/api/garments/bulk-edit',{garment_ids:Array(101).fill(a.id),set:{brand:'x'}})).status===400);
check('批量修改需要登入',(await call('/api/garments/bulk-edit',{garment_ids:[a.id],set:{brand:'x'}},false)).status===401);
// Custom swatches persist across clients and preserve named shades on save.
check('新增顏色需要登入',(await call('/api/settings/colors',{name:'酒紅',hex:'#631328'},false)).status===401);
check('拒絕無效色碼',(await call('/api/settings/colors',{name:'酒紅',hex:'red'})).status===400);
r=await call('/api/settings/colors',{name:'酒紅',hex:'#631328'});
check('新增顏色回傳色碼',r.status===201&&r.data['酒紅']==='#631328');
check('顏色可以重新讀取',(await call('/api/settings/colors')).data['酒紅']==='#631328');
const tax=(await call('/api/taxonomy')).data;
check('主要及次要顏色共用新選項',['primary_color','secondary_colors'].every(id=>tax.attributes.find(x=>x.id===id).options.some(o=>o.name==='酒紅')));
check('拒絕重複顏色',(await call('/api/settings/colors',{name:'酒紅',hex:'#111111'})).status===409);
await call('/api/garments/bulk-edit',{garment_ids:[a.id],set:{primary_color:['酒紅'],secondary_colors:['酒紅']}});
aa=(await call(`/api/garments/${a.id}`)).data;
check('自訂色不被舊顏色映射覆蓋',aa.primary_color==='酒紅'&&aa.secondary_colors[0]==='酒紅');
env.DB.failNextBatch=true;
check('色票寫入失敗回報',(await call('/api/settings/colors',{name:'測試藍',hex:'#224488'})).status===500);
check('失敗不留下色碼或部分分類',!(await call('/api/settings/colors')).data['測試藍']&&!(await call('/api/taxonomy')).data.attributes.some(a=>a.options.some(o=>o.name==='測試藍')));
// Free-text metadata persists without a schema migration and survives unrelated edits.
const originalName = '星月の庭 '.repeat(20).trim();
const sourceUrl = 'https://example.com/product?name=' + 'a'.repeat(150);
r=await call('/api/garments/bulk-edit',{garment_ids:[a.id],set:{attributes:{original_name:originalName,source_url:sourceUrl}}});
check('原文名稱及長網址可儲存',r.data.results[0].ok);
aa=(await call(`/api/garments/${a.id}`)).data;
check('原文和網址讀回不被40字截斷',aa.attributes.original_name===originalName&&aa.attributes.source_url===sourceUrl);
await call('/api/garments/bulk-edit',{garment_ids:[a.id],set:{attributes:{condition:'良好'}}});
aa=(await call(`/api/garments/${a.id}`)).data;
check('修改其他屬性保留原文連結',aa.attributes.source_url===sourceUrl&&aa.attributes.original_name===originalName);
check('拒絕可執行網址',(await call('/api/garments/bulk-edit',{garment_ids:[a.id],set:{attributes:{source_url:'javascript:alert(1)'}}})).status===400);
await call('/api/garments/bulk-edit',{garment_ids:[a.id],set:{attributes:{source_url:null}}});
aa=(await call(`/api/garments/${a.id}`)).data;
check('清空連結保留其他屬性',!aa.attributes.source_url&&aa.attributes.original_name===originalName&&aa.attributes.condition==='良好');
// Two original-image families, each with a derived cutout/thumbnail.
for(const [id,parent,type] of [['a-root',null,'original'],['a-cut','a-root','processed'],['a-thumb','a-cut','thumbnail'],['b-root',null,'original'],['b-cut','b-root','processed'],['b-thumb','b-cut','thumbnail']]){
 await env.DB.prepare('INSERT INTO garment_images (id,garment_id,image_type,r2_key,mime_type,width,height,file_size,sha256,has_alpha,is_primary,derived_from,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,a.id,type,id,'image/png',100,100,4,id,type==='processed'?1:0,id==='a-cut'?1:0,parent,new Date().toISOString()).run();
 await env.IMAGES.put(id,new Uint8Array([1,2,3,4]));
}
await env.DB.prepare("INSERT INTO ai_image_links (image_id,garment_id,purpose,url,expires_at,created_at) VALUES ('b-root',?,'analysis','https://test.example/image','2099-01-01','2026-11-11')").bind(a.id).run();
const keys=JSON.stringify([...env.IMAGES.objects.keys()]);
check('不可以拆出所有圖片',(await call(`/api/garments/${a.id}/split`,{image_ids:['a-root','b-root']})).status===400);
check('不可以拆其他衣物圖片',(await call(`/api/garments/${b.id}/split`,{image_ids:['b-root']})).status===409);
check('拆開需要登入',(await call(`/api/garments/${a.id}/split`,{image_ids:['b-root']},false)).status===401);
env.DB.failNextBatch=true;
check('拆開交易失敗回報',(await call(`/api/garments/${a.id}/split`,{image_ids:['b-root']})).status===500);
check('交易失敗原圖片全數保留',(await call(`/api/garments/${a.id}`)).data.images.length===6);
r=await call(`/api/garments/${a.id}/split`,{image_ids:['b-cut']});
check('選擇衍生圖會整組拆開',r.status===200&&r.data.moved_image_ids.length===3&&r.data.moved_image_ids.includes('b-root'));
check('兩件各保留唯一主圖',r.data.garment.images.filter(i=>i.is_primary).length===1&&r.data.source.images.filter(i=>i.is_primary).length===1);
check('新衣物等待AI辨認',r.data.garment.ai_status==='pending_ai'&&r.data.garment.name_is_placeholder&&r.data.garment.brand===null);
check('原衣物保留資訊',r.data.source.notes==='部分成功');
check('原檔完全不動',JSON.stringify([...env.IMAGES.objects.keys()])===keys);
check('AI圖片連結跟隨拆開',(await env.DB.prepare("SELECT garment_id FROM ai_image_links WHERE image_id='b-root'").first()).garment_id===r.data.garment.id);
check('重試舊拆開不重複新增',(await call(`/api/garments/${a.id}/split`,{image_ids:['b-root']})).status===409);
const newId=r.data.garment.id;
check('可以重新合併拆出的衣物',(await call(`/api/garments/${a.id}/merge`,{source_id:newId})).status===200);
log(`結果：${passed} 項通過`);
