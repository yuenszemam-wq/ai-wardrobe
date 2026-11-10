import { currentTaxonomy } from "./taxonomy";
import { GARMENT_FIELDS } from '../shared/taxonomy';
import { getGarment, normalizeGarment, parseAttributes, updateGarment } from './garments';
import { Actor, Env, HttpError, audit, newId, nowIso } from './util';

/** Explicit per-field patch, with per-item results so failed records can be retried safely. */
export async function bulkEdit(env: Env, actor: Actor, input: { garment_ids?: unknown; set?: unknown }) {
  if (!Array.isArray(input.garment_ids) || !input.garment_ids.length || input.garment_ids.length > 100)
    throw new HttpError(400, 'bad_ids', '每次請選取 1–100 件衣物');
  const ids = [...new Set(input.garment_ids.map(String))];
  if (!input.set || typeof input.set !== 'object' || Array.isArray(input.set)) throw new HttpError(400, 'bad_patch', '請選擇要修改的欄位');
  const patch = input.set as Record<string, unknown>;
  const allowed = new Set<string>([...GARMENT_FIELDS, 'price', 'status', 'is_favorite']);
  if (!Object.keys(patch).length || Object.keys(patch).some((k) => !allowed.has(k))) throw new HttpError(400, 'bad_patch', '包含不支援的欄位');
  if ('name' in patch && !String(patch.name || '').trim()) throw new HttpError(400, 'bad_name', '名稱不可清空');
  if ('status' in patch && !['active', 'review', 'archived'].includes(String(patch.status))) throw new HttpError(400, 'bad_status', '請選擇有效狀態');
  if ('attributes' in patch && (!patch.attributes || typeof patch.attributes !== 'object' || Array.isArray(patch.attributes))) throw new HttpError(400, 'bad_attributes', '屬性格式錯誤');
  const normalized = normalizeGarment(patch, true);
  if (normalized.uncertain.some(k => k in patch)) throw new HttpError(400, "bad_patch", "請選擇分類字典內的有效選項");
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of ids) {
    try {
      const g = await env.DB.prepare('SELECT * FROM garments WHERE id=?').bind(id).first<Record<string, unknown>>();
      if (!g) throw new Error('找不到衣物');
      const body = { ...patch };
      if (body.subcategory) {
        const category = String(body.category ?? g.category ?? '');
        if (!currentTaxonomy().categories.find(c => c.name === category)?.subs.some(s => s.name === body.subcategory))
          throw new Error('子分類不屬於這件衣物的主分類，請同時指定主分類');
      }
      if ('category' in body && !('subcategory' in body)) body.subcategory = null;
      // Only selected attribute keys change; keep unrelated attributes of each garment.
      if ('attributes' in body) body.attributes = { ...parseAttributes(g.attributes), ...body.attributes as Record<string, unknown> };
      await updateGarment(env, actor, id, { ...body, expected_version: Number(g.version) });
      results.push({ id, ok: true });
    } catch (e) { results.push({ id, ok: false, error: (e as Error).message }); }
  }
  return { results };
}

/** Split image families, including derived cutouts/previews/thumbnails, without touching R2. */
export async function splitGarment(env: Env, actor: Actor, sourceId: string, input: { image_ids?: unknown }) {
  if (!Array.isArray(input.image_ids) || !input.image_ids.length || input.image_ids.length > 100)
    throw new HttpError(400, 'bad_images', '請選擇要拆出的圖片');
  const source = await env.DB.prepare('SELECT * FROM garments WHERE id=?').bind(sourceId).first<Record<string, unknown>>();
  if (!source || source.status === 'archived') throw new HttpError(404, 'garment_not_found', '找不到可拆開的衣物');
  const { results: images } = await env.DB.prepare('SELECT id, derived_from, image_type, variant FROM garment_images WHERE garment_id=?').bind(sourceId).all<{id:string; derived_from:string|null; image_type:string; variant:string|null}>();
  const byId = new Map(images.map((i) => [i.id, i]));
  function root(id: string) {
    const seen = new Set<string>();
    while (byId.get(id)?.derived_from && byId.has(byId.get(id)!.derived_from!)) {
      if (seen.has(id)) throw new HttpError(409, 'image_cycle', '圖片關聯異常，未作修改');
      seen.add(id); id = byId.get(id)!.derived_from!;
    }
    return id;
  }
  const selected = input.image_ids.map(String);
  if (selected.some((id) => !byId.has(id))) throw new HttpError(409, 'image_changed', '圖片已移動，請重新載入');
  const roots = new Set(selected.map(root));
  const moved = images.filter((i) => roots.has(root(i.id)));
  const remaining = images.filter((i) => !roots.has(root(i.id)));
  if (!remaining.some((i) => i.image_type !== 'thumbnail' && i.variant !== 'analysis')) throw new HttpError(400, 'split_all', '原衣物至少要保留一組圖片');
  const id = newId('gar'), now = nowIso();
  const guard = 'EXISTS (SELECT 1 FROM garments WHERE id=?)';
  const statements = [env.DB.prepare(`INSERT INTO garments (id,name,status,source,created_at,updated_at,ai_status,name_is_placeholder,display_no,version)
    SELECT ?, '待整理衣物 ' || printf('%03d', COALESCE((SELECT MAX(display_no) FROM garments),0)+1), 'review','manual',?,?, 'pending_ai',1,COALESCE((SELECT MAX(display_no) FROM garments),0)+1,1
    FROM garments WHERE id=? AND version=?`).bind(id,now,now,sourceId,source.version)];
  for (const image of moved) statements.push(env.DB.prepare(`UPDATE garment_images SET garment_id=?,is_primary=0 WHERE id=? AND garment_id=? AND ${guard}`).bind(id,image.id,sourceId,id));
  statements.push(env.DB.prepare(`UPDATE ai_image_links SET garment_id=? WHERE image_id IN (SELECT id FROM garment_images WHERE garment_id=?) AND ${guard}`).bind(id,id,id));
  for (const gid of [id, sourceId]) {
    statements.push(env.DB.prepare(`UPDATE garment_images SET is_primary=0 WHERE garment_id=? AND ${guard}`).bind(gid,id));
    statements.push(env.DB.prepare(`UPDATE garment_images SET is_primary=1 WHERE id=(SELECT id FROM garment_images WHERE garment_id=? AND image_type!='thumbnail' AND (variant IS NULL OR variant='preview')
      ORDER BY CASE WHEN image_type='processed' AND has_alpha=1 THEN 0 ELSE 1 END, created_at,id LIMIT 1) AND ${guard}`).bind(gid,id));
  }
  statements.push(env.DB.prepare(`UPDATE garments SET version=version+1,updated_at=?,ai_status=CASE WHEN ai_status IS NOT NULL AND ai_status!='done' THEN 'pending_ai' ELSE ai_status END,ai_claimed_at=NULL,ai_claimed_by=NULL WHERE id=? AND ${guard}`).bind(now,sourceId,id));
  statements.push(env.DB.prepare(`UPDATE ai_suggestions SET status='superseded' WHERE garment_id=? AND status IN ('submitted','valid') AND ${guard}`).bind(sourceId,id));
  const result = await env.DB.batch(statements);
  if (!result[0].meta.changes) throw new HttpError(409, 'version_conflict', '衣物已更新，請重新載入再拆開');
  await audit(env, actor, 'garment.split', sourceId, { new_id:id, image_ids:moved.map((i)=>i.id) });
  return { garment: await getGarment(env,id), source: await getGarment(env,sourceId), moved_image_ids:moved.map((i)=>i.id) };
}
