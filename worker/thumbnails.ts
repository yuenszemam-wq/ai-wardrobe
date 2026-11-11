import { Env, HttpError, json, nowIso, sha256Hex, todayHk } from './util';
import { parseImage } from './images';
import { encodeThumbnail } from './thumbnailCodec';

export const THUMB_LIMIT=30720;
// Application budgets, not an account-wide billing cap. Every attempted GET is reserved first.
export const DAILY_R2_READS=600;
const DAILY_REQUESTS=12000, DAILY_BYTES=192*1024*1024;
const ownerTable=(owner:string)=>owner==='outfit'?'outfit_images':'garment_images';
const thumbTable=(owner:string)=>owner==='outfit'?'outfit_thumbnails':'garment_thumbnails';

export async function saveThumbnail(env:Env,imageId:string,owner:string,sourceSha:string,bytes:Uint8Array) {
  const info=parseImage(bytes);
  if(info.mime!=='image/webp'||bytes.byteLength>THUMB_LIMIT||info.width>240||info.height>300) throw new Error('invalid_thumbnail');
  const version='w1-'+await sha256Hex(bytes);
  const fk=owner==='outfit'?'outfit_id':'garment_id';
  // Source SHA condition prevents a late encoder from overwriting a replacement. Owner read here
  // (not at job start) makes merge/split safe while an image is being encoded.
  const result=await env.DB.prepare(`INSERT INTO ${thumbTable(owner)}
    (image_id,${fk},data,mime_type,byte_size,width,height,has_alpha,source_sha256,version,updated_at)
    SELECT id,${fk},?,'image/webp',?,?,?,?,?,?,? FROM ${ownerTable(owner)} WHERE id=? AND sha256=?
    ON CONFLICT(image_id) DO UPDATE SET ${fk}=excluded.${fk},data=excluded.data,byte_size=excluded.byte_size,
    width=excluded.width,height=excluded.height,has_alpha=excluded.has_alpha,source_sha256=excluded.source_sha256,
    version=excluded.version,updated_at=excluded.updated_at`).bind(Array.from(bytes),bytes.byteLength,info.width,info.height,info.hasAlpha?1:0,sourceSha,version,nowIso(),imageId,sourceSha).run();
  if(result.meta.changes) await env.DB.prepare("DELETE FROM thumbnail_jobs WHERE image_id=?").bind(imageId).run();
  return version;
}

/** Browser-generated derivatives require no R2 read and never run an encoder on the upload path. */
export async function acceptSmallThumbnail(env:Env,imageId:string,owner:string,sha:string,bytes:Uint8Array,derivedFrom?:string|null) {
  try {
    const p=parseImage(bytes);
    if(p.mime!=='image/webp'||p.width>240||p.height>300||bytes.byteLength>THUMB_LIMIT) return;
    await saveThumbnail(env,imageId,owner,sha,bytes);
    if(owner==='garment'&&derivedFrom) {
      const source=await env.DB.prepare('SELECT sha256 FROM garment_images WHERE id=?').bind(derivedFrom).first<{sha256:string}>();
      if(source) await saveThumbnail(env,derivedFrom,owner,source.sha256,bytes);
    }
  } catch(e) { console.warn(JSON.stringify({thumbnail:'deferred',image_id:imageId,error:String(e)})); }
}

export async function processThumbnailJobs(env:Env,limit=4) {
  const day=todayHk();
  await env.DB.prepare('INSERT OR IGNORE INTO thumbnail_usage(day) VALUES(?)').bind(day).run();
  const usage=await env.DB.prepare('SELECT r2_reads FROM thumbnail_usage WHERE day=?').bind(day).first<{r2_reads:number}>();
  if((usage?.r2_reads??0)>=DAILY_R2_READS) return {done:0,paused:'daily_r2_budget'};
  let done=0,failed=0;
  // One sequential decoder per invocation; leases survive isolate restarts and overlapping cron runs.
  for(let n=0;n<Math.min(32,limit);n++) {
    const now=nowIso(), lease=crypto.randomUUID();
    const job=await env.DB.prepare(`UPDATE thumbnail_jobs SET state='working',lease=?,attempts=attempts+1,
      next_attempt_at=?,updated_at=? WHERE image_id=(SELECT j.image_id FROM thumbnail_jobs j
      LEFT JOIN garment_images i ON i.id=j.image_id
      WHERE j.state IN ('pending','working') AND j.next_attempt_at<=?
      ORDER BY COALESCE(i.is_primary,0) DESC,j.updated_at,j.image_id LIMIT 1)
      RETURNING image_id,owner,attempts`).bind(lease,new Date(Date.now()+300000).toISOString(),now,now).first<{image_id:string;owner:string;attempts:number}>();
    if(!job) break;
    try {
      const src=await env.DB.prepare(`SELECT r2_key,sha256,mime_type,width,height,file_size FROM ${ownerTable(job.owner)} WHERE id=?`).bind(job.image_id).first<any>();
      if(!src) { await env.DB.prepare('DELETE FROM thumbnail_jobs WHERE image_id=? AND lease=?').bind(job.image_id,lease).run();continue; }
      // Prefer the existing matching R2 derivative; never change or move the source object.
      let input=src;
      if(job.owner==='garment') input=await env.DB.prepare(`SELECT r2_key,sha256,mime_type,width,height,file_size FROM garment_images
        WHERE derived_from=? AND image_type='thumbnail' AND variant IS NULL ORDER BY file_size LIMIT 1`).bind(job.image_id).first<any>()??src;
      if(!['image/png','image/jpeg','image/webp'].includes(input.mime_type)) throw new Error('unsupported_format_needs_preview');
      if(input.width*input.height>6000000||input.file_size>12*1024*1024) throw new Error('source_exceeds_safe_decode_budget');
      const reservation=await env.DB.prepare('UPDATE thumbnail_usage SET r2_reads=r2_reads+1 WHERE day=? AND r2_reads<? RETURNING r2_reads').bind(day,DAILY_R2_READS).first();
      if(!reservation) {
        await env.DB.prepare("UPDATE thumbnail_jobs SET state='pending',attempts=attempts-1,next_attempt_at='',lease=NULL WHERE image_id=? AND lease=?").bind(job.image_id,lease).run();break;
      }
      const obj=await env.IMAGES.get(input.r2_key);
      if(!obj) throw new Error('object_missing');
      const bytes=new Uint8Array(await new Response(obj.body).arrayBuffer());
      if(await sha256Hex(bytes)!==input.sha256) throw new Error("source_checksum_mismatch");
      const output=await encodeThumbnail(bytes,input.mime_type);
      await saveThumbnail(env,job.image_id,job.owner,src.sha256,output);
      done++;
    } catch(e) {
      const reason=String(e).slice(0,240);failed++;
      const terminal=job.attempts>=3||/unsupported_format|safe_decode/.test(reason);
      await env.DB.prepare('UPDATE thumbnail_jobs SET state=?,next_attempt_at=?,last_error=?,lease=NULL,updated_at=? WHERE image_id=? AND lease=?')
        .bind(terminal?'failed':'pending',new Date(Date.now()+job.attempts*600000).toISOString(),reason,nowIso(),job.image_id,lease).run();
      console.warn(JSON.stringify({thumbnail:'failed',image_id:job.image_id,reason}));
    }
  }
  return {done,failed};
}

const bytesOf=(data:any)=>data instanceof ArrayBuffer?new Uint8Array(data):new Uint8Array(data);
const SELECT=`SELECT image_id,version,mime_type,byte_size,width,height,has_alpha,data FROM garment_thumbnails
 UNION ALL SELECT image_id,version,mime_type,byte_size,width,height,has_alpha,data FROM outfit_thumbnails`;
async function reserveResponse(env:Env,reservedBytes:number) {
  const result=await env.DB.prepare(`INSERT INTO thumbnail_usage(day,read_requests,response_bytes) VALUES(?,1,?)
   ON CONFLICT(day) DO UPDATE SET read_requests=read_requests+1,response_bytes=response_bytes+excluded.response_bytes
   WHERE read_requests<? AND response_bytes+excluded.response_bytes<=? RETURNING day`)
   .bind(todayHk(),reservedBytes,DAILY_REQUESTS,DAILY_BYTES).first();
  if(!result) throw new HttpError(429,'thumbnail_budget','今日縮圖讀取預算已用完，已快取圖片仍可使用');
}
async function accountReads(env:Env,rows:number,bytes:number,reserved:number) {
  // D1 rows_read is reported by D1 (includes index work), not equated to returned thumbnails.
  await env.DB.prepare(`UPDATE thumbnail_usage SET rows_read=rows_read+?,rows_written=rows_written+2,
    response_bytes=MAX(0,response_bytes-?+?) WHERE day=?`).bind(rows,reserved,bytes,todayHk()).run();
}
export async function thumbnailApi(req:Request,env:Env,imageId?:string):Promise<Response> {
  const url=new URL(req.url);
  if(imageId) {
    await reserveResponse(env,THUMB_LIMIT);
    const result=await env.DB.prepare(`SELECT * FROM (${SELECT}) WHERE image_id=?`).bind(imageId).all<any>();
    const row=result.results[0],etag=row?`"${row.version}"`:'';
    const unchanged=row&&req.headers.get('if-none-match')===etag;
    await accountReads(env,result.meta?.rows_read??1,unchanged?0:row?.byte_size??0,THUMB_LIMIT);
    if(!row) return json({error:{code:'thumbnail_pending',message:'縮圖準備中'}},404,{'retry-after':'60'});
    const versioned=url.searchParams.get('v')===row.version;
    const headers={'content-type':'image/webp',etag,'cache-control':versioned?'private, max-age=31536000, immutable':'private, max-age=3600','x-thumbnail-version':row.version};
    if(unchanged) return new Response(null,{status:304,headers});
    return new Response(bytesOf(row.data),{headers});
  }
  const ids=[...new Set((url.searchParams.get('ids')??'').split(',').filter(Boolean))];
  const limit=Math.min(16,Math.max(1,Number(url.searchParams.get('limit'))||16));
  if(ids.length>16||ids.some(id=>!/^img_[a-z2-7]+$/.test(id))) throw new HttpError(400,'bad_thumbnail_ids','每次最多 16 張縮圖');
  const includeData=url.searchParams.get('data')==='1';
  const reserved=includeData?(ids.length||limit)*(THUMB_LIMIT*4/3+1024):16384;
  await reserveResponse(env,reserved);
  const fields='image_id,version,mime_type,byte_size,width,height,has_alpha'+(includeData?',data':'');
  const cursor=url.searchParams.get('cursor')??'';
  const where=ids.length?`image_id IN (${ids.map(()=>'?').join(',')})`:'image_id>?';
  const result=await env.DB.prepare(`SELECT ${fields} FROM (${SELECT}) WHERE ${where} ORDER BY image_id LIMIT ?`).bind(...(ids.length?ids:[cursor]),limit).all<any>();
  const items=result.results.map(row=>{
    const {data,...meta}=row;
    return {...meta,url:`/api/thumbnails/${row.image_id}?v=${row.version}`,...(includeData?{base64:btoa(String.fromCharCode(...bytesOf(data)))}:{})};
  });
  const body={items,missing:ids.filter(id=>!items.some(i=>i.image_id===id)),next_cursor:!ids.length&&items.length===limit?items.at(-1).image_id:null};
  const serialized=JSON.stringify(body);
  await accountReads(env,result.meta?.rows_read??items.length,new TextEncoder().encode(serialized).length,reserved);
  return new Response(serialized,{headers:{'content-type':'application/json','cache-control':'private, max-age=300'}});
}
export async function thumbnailStatus(env:Env) {
  const results=await env.DB.batch([
    env.DB.prepare('SELECT state,COUNT(*) AS count FROM thumbnail_jobs GROUP BY state'),
    env.DB.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(byte_size),0) AS bytes FROM garment_thumbnails'),
    env.DB.prepare('SELECT * FROM thumbnail_usage WHERE day=?').bind(todayHk()),
    env.DB.prepare("SELECT image_id,last_error FROM thumbnail_jobs WHERE state='failed' LIMIT 20")
  ]);
  return {jobs:results[0].results,storage:results[1].results[0],today:results[2].results[0]??{},failed:results[3].results,
    limits:{r2_reads:DAILY_R2_READS,read_requests:DAILY_REQUESTS,response_bytes:DAILY_BYTES},scope:'thumbnail subsystem only; other app/account usage is additional'};
}

/** Free-plan processor: lease one image to an authenticated foreground browser; no server decode CPU. */
export async function claimBrowserThumbnail(env:Env) {
  const now=nowIso(),lease=crypto.randomUUID();
  await env.DB.prepare("UPDATE thumbnail_jobs SET state='failed',last_error=COALESCE(last_error,'browser_decode_failed') WHERE attempts>=3 AND state IN ('pending','working') AND next_attempt_at<=?").bind(now).run();
  const job=await env.DB.prepare(`UPDATE thumbnail_jobs SET state='working',lease=?,attempts=attempts+1,next_attempt_at=?,updated_at=?
    WHERE image_id=(SELECT image_id FROM thumbnail_jobs WHERE state IN ('pending','working') AND next_attempt_at<=? AND attempts<3 ORDER BY updated_at LIMIT 1)
    RETURNING image_id,owner`).bind(lease,new Date(Date.now()+300000).toISOString(),now,now).first<{image_id:string;owner:string}>();
  if(!job)return json({job:null});
  return json({job:{...job,lease}});
}
export async function browserThumbnailSource(env:Env,imageId:string,lease:string) {
  const job=await env.DB.prepare("SELECT owner FROM thumbnail_jobs WHERE image_id=? AND lease=? AND state='working' AND next_attempt_at>?").bind(imageId,lease,nowIso()).first<{owner:string}>();
  if(!job)throw new HttpError(409,'thumbnail_lease','縮圖工作已過期');
  const src=await env.DB.prepare(`SELECT r2_key,sha256,mime_type FROM ${ownerTable(job.owner)} WHERE id=?`).bind(imageId).first<any>();
  if(!src)throw new HttpError(404,'image_not_found','找不到原圖');
  // Every source request (including retry) reserves an operation atomically before R2.
  const reservation=await env.DB.prepare(`INSERT INTO thumbnail_usage(day,r2_reads) VALUES(?,1)
    ON CONFLICT(day) DO UPDATE SET r2_reads=r2_reads+1 WHERE r2_reads<? RETURNING day`).bind(todayHk(),DAILY_R2_READS).first();
  if(!reservation){await env.DB.prepare("UPDATE thumbnail_jobs SET state='pending',attempts=MAX(0,attempts-1),lease=NULL,next_attempt_at='' WHERE image_id=? AND lease=?").bind(imageId,lease).run();throw new HttpError(429,'thumbnail_budget','今日補建額度已用完');}
  const object=await env.IMAGES.get(src.r2_key);
  if(!object)throw new HttpError(404,'object_missing','R2 原圖不存在');
  return new Response(object.body,{headers:{'content-type':src.mime_type,'cache-control':'no-store','x-source-sha':src.sha256}});
}
export async function finishBrowserThumbnail(req:Request,env:Env,imageId:string,lease:string) {
  const job=await env.DB.prepare("SELECT owner FROM thumbnail_jobs WHERE image_id=? AND lease=? AND state='working' AND next_attempt_at>?").bind(imageId,lease,nowIso()).first<{owner:string}>();
  if(!job)throw new HttpError(409,'thumbnail_lease','縮圖工作已過期');
  if(req.headers.get('content-type')!=='image/webp'||Number(req.headers.get('content-length')||0)>THUMB_LIMIT)throw new HttpError(413,'thumbnail_size','縮圖必須是 30 KB 以內的 WebP');
  const bytes=new Uint8Array(await req.arrayBuffer());
  if(bytes.length>THUMB_LIMIT)throw new HttpError(413,'thumbnail_size','縮圖超出上限');
  const version=await saveThumbnail(env,imageId,job.owner,req.headers.get('x-source-sha')??'',bytes);
  return json({ok:true,version});
}
