/** Local/admin fallback. Input manifest is metadata only; source files were fetched under a reserved
 * R2 budget. Emits per-image SQL journals, never writes R2. Resume by skipping existing .sql files.
 * Usage: SHARP_PATH=/path/to/sharp node scripts/encode-thumbnail-backfill.mjs DIR
 */
import {readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const sharp=createRequire(import.meta.url)(process.env.SHARP_PATH||'sharp');
const dir=process.argv[2];if(!dir)throw new Error('Provide backfill directory');
const images=JSON.parse(readFileSync(`${dir}/manifest.json`,'utf8'));
const q=s=>"'"+String(s).replaceAll("'","''")+"'";
let done=0,waiting=0;
for(const image of images) {
 const path=`${dir}/${image.id}`;
 if(existsSync(path+'.sql'))continue;
 if(!existsSync(path+'.source')){waiting++;continue;}
 try {
  const original=readFileSync(path+'.source');
  if(createHash('sha256').update(original).digest('hex')!==image.sha256)throw new Error('source_checksum_mismatch');
  let output;
  for(const factor of [1,.8,.64,.5]) {
   for(const quality of [82,68,50]) {
    output=await sharp(original,{limitInputPixels:16000000}).rotate().resize({width:Math.round(240*factor),height:Math.round(300*factor),fit:'inside',withoutEnlargement:true}).webp({quality,alphaQuality:100,effort:3}).toBuffer();
    if(output.length<=30720)break;
   }
   if(output.length<=30720)break;
  }
  if(output.length>30720)throw new Error('thumbnail_size_limit');
  const info=await sharp(output).metadata(),version='w1-'+createHash('sha256').update(output).digest('hex');
  const sql=`INSERT INTO garment_thumbnails(image_id,garment_id,data,mime_type,byte_size,width,height,has_alpha,source_sha256,version,updated_at)
   SELECT id,garment_id,X'${output.toString('hex')}','image/webp',${output.length},${info.width},${info.height},${info.hasAlpha?1:0},sha256,${q(version)},${q(new Date().toISOString())}
   FROM garment_images WHERE id=${q(image.id)} AND sha256=${q(image.sha256)}
   ON CONFLICT(image_id) DO UPDATE SET garment_id=excluded.garment_id,data=excluded.data,byte_size=excluded.byte_size,width=excluded.width,height=excluded.height,has_alpha=excluded.has_alpha,source_sha256=excluded.source_sha256,version=excluded.version,updated_at=excluded.updated_at;
   DELETE FROM thumbnail_jobs WHERE image_id=${q(image.id)} AND EXISTS(SELECT 1 FROM garment_thumbnails WHERE image_id=${q(image.id)} AND source_sha256=${q(image.sha256)});`;
  writeFileSync(path+'.sql',sql);writeFileSync(path+'.meta.json',JSON.stringify({id:image.id,bytes:output.length,width:info.width,height:info.height,alpha:info.hasAlpha}));
  unlinkSync(path+'.source');done++;
 }catch(e){writeFileSync(path+'.encode-error.json',JSON.stringify({id:image.id,error:String(e)}));}
}
console.log(JSON.stringify({encoded:done,waiting}));
