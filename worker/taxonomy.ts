// 分類字典（D1 taxonomy 表）：讀取、首次寫入預設值、增加／改名／刪除／排序。
// 改名會連帶更新已入庫衣物的值；刪除只移除字典項目，已入庫衣物保留原來的文字，不會被刪除或改動。

import {
  buildTaxonomy,
  defaultTaxonomyRows,
  isColumnAttribute,
  joinMulti,
  splitMulti,
  TaxKind,
  TaxNode,
  Taxonomy,
} from "../shared/taxonomy";
import { Actor, Env, HttpError, audit, newId, nowIso, parseJsonArray, str } from "./util";

const SEEDED_KEY = "taxonomy_seeded";
const CACHE_MS = 30_000;
let cache: { at: number; tax: Taxonomy; rows: TaxNode[] } | null = null;
let fallback: Taxonomy | null = null;

/** 同步取得目前的分類字典（未載入時用預設值）。供 normalizeGarment 等同步函數使用。 */
export function currentTaxonomy(): Taxonomy {
  if (cache) return cache.tax;
  return (fallback ??= buildTaxonomy(defaultTaxonomyRows()));
}

export function invalidateTaxonomy() {
  cache = null;
}

function rowToNode(r: Record<string, unknown>): TaxNode {
  return {
    id: String(r.id),
    kind: r.kind as TaxKind,
    parent_id: (r.parent_id as string | null) ?? null,
    name: String(r.name),
    sort_order: Number(r.sort_order) || 0,
    multi: Number(r.multi) === 1,
    max_select: r.max_select === null || r.max_select === undefined ? null : Number(r.max_select),
    show_for: r.show_for ? parseJsonArray(r.show_for) : null,
  };
}

async function seedIfNeeded(env: Env) {
  const flag = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(SEEDED_KEY).first();
  if (flag) return;
  const now = nowIso();
  const rows = defaultTaxonomyRows();
  const stmts = rows.map((n) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO taxonomy (id, kind, parent_id, name, sort_order, multi, max_select, show_for, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).bind(n.id, n.kind, n.parent_id, n.name, n.sort_order, n.multi ? 1 : 0, n.max_select, n.show_for ? JSON.stringify(n.show_for) : null, now, now),
  );
  stmts.push(env.DB.prepare("INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, '1', ?)").bind(SEEDED_KEY, now));
  // 主分類及屬性先寫入（子項目有外鍵）
  await env.DB.batch(stmts);
}

/** 載入分類字典（30 秒快取）；第一次使用時寫入預設分類 */
export async function ensureTaxonomy(env: Env): Promise<Taxonomy> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.tax;
  try {
    await seedIfNeeded(env);
    const { results } = await env.DB.prepare("SELECT * FROM taxonomy").all<Record<string, unknown>>();
    const rows = results.map(rowToNode);
    cache = { at: Date.now(), rows, tax: buildTaxonomy(rows) };
    return cache.tax;
  } catch (e) {
    // migration 未套用時退回預設值，不影響其他功能
    console.error("taxonomy load failed", e);
    return currentTaxonomy();
  }
}

export async function getTaxonomy(env: Env, withUsage: boolean) {
  invalidateTaxonomy();
  const tax = await ensureTaxonomy(env);
  if (!withUsage) return tax;
  const { results: cats } = await env.DB.prepare(
    "SELECT category, subcategory, COUNT(*) AS n FROM garments WHERE status != 'archived' GROUP BY category, subcategory",
  ).all<{ category: string | null; subcategory: string | null; n: number }>();
  const usage: Record<string, number> = {};
  for (const c of tax.categories) {
    usage[c.id] = cats.filter((r) => r.category === c.name).reduce((s, r) => s + r.n, 0);
    for (const s of c.subs) usage[s.id] = cats.filter((r) => r.category === c.name && r.subcategory === s.name).reduce((sum, r) => sum + r.n, 0);
  }
  return { ...tax, usage };
}

async function getNode(env: Env, id: string): Promise<TaxNode> {
  const r = await env.DB.prepare("SELECT * FROM taxonomy WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!r) throw new HttpError(404, "taxonomy_not_found", "找不到這個分類");
  return rowToNode(r);
}

async function assertUniqueName(env: Env, kind: TaxKind, parentId: string | null, name: string, exceptId?: string) {
  const dup = await env.DB.prepare(
    "SELECT id FROM taxonomy WHERE kind = ? AND COALESCE(parent_id, '') = ? AND name = ? AND id != ?",
  )
    .bind(kind, parentId ?? "", name, exceptId ?? "")
    .first();
  if (dup) throw new HttpError(409, "duplicate_name", `「${name}」已經存在`);
}

function cleanShowFor(v: unknown): string | null {
  if (v === null) return null;
  if (!Array.isArray(v)) return null;
  const ids = v.map(String).filter((x) => /^[\w-]{1,40}$/.test(x)).slice(0, 50);
  return ids.length ? JSON.stringify(ids) : null;
}

export interface TaxInput {
  kind?: unknown;
  parent_id?: unknown;
  name?: unknown;
  multi?: unknown;
  max_select?: unknown;
  show_for?: unknown;
}

export async function createTaxNode(env: Env, actor: Actor, input: TaxInput) {
  const kind = String(input.kind || "") as TaxKind;
  if (!["category", "subcategory", "attribute", "option"].includes(kind)) throw new HttpError(400, "bad_kind", "kind 只可以是 category、subcategory、attribute、option");
  const name = str(input.name, 40);
  if (!name) throw new HttpError(400, "missing_name", "請輸入名稱");
  let parentId: string | null = null;
  if (kind === "subcategory" || kind === "option") {
    parentId = str(input.parent_id, 40);
    if (!parentId) throw new HttpError(400, "missing_parent", "需要上層分類");
    const parent = await getNode(env, parentId);
    if (parent.kind !== (kind === "subcategory" ? "category" : "attribute")) throw new HttpError(400, "bad_parent", "上層分類類型不正確");
  }
  await assertUniqueName(env, kind, parentId, name);
  const max = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM taxonomy WHERE kind = ? AND COALESCE(parent_id, '') = ?")
    .bind(kind, parentId ?? "")
    .first<{ m: number }>();
  const id = newId(kind === "category" ? "cat" : kind === "subcategory" ? "sub" : kind === "attribute" ? "attr" : "opt");
  const now = nowIso();
  const maxSel = Number(input.max_select);
  await env.DB.prepare(
    "INSERT INTO taxonomy (id, kind, parent_id, name, sort_order, multi, max_select, show_for, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id, kind, parentId, name, (max?.m ?? -1) + 1,
      kind === "attribute" && input.multi ? 1 : 0,
      kind === "attribute" && Number.isInteger(maxSel) && maxSel > 0 ? maxSel : null,
      kind === "attribute" ? cleanShowFor(input.show_for) : null,
      now, now,
    )
    .run();
  invalidateTaxonomy();
  await audit(env, actor, "taxonomy.create", id, { kind, name });
  return getNode(env, id);
}

export async function updateTaxNode(env: Env, actor: Actor, id: string, input: TaxInput) {
  const node = await getNode(env, id);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  const sets: string[] = [];
  const binds: unknown[] = [];
  let renamed: { from: string; to: string } | null = null;
  let movedTo: TaxNode | null = null;

  if (has("name")) {
    const name = str(input.name, 40);
    if (!name) throw new HttpError(400, "missing_name", "名稱不可留空");
    if (name !== node.name) {
      await assertUniqueName(env, node.kind, node.parent_id, name, id);
      sets.push("name = ?");
      binds.push(name);
      renamed = { from: node.name, to: name };
    }
  }
  // 子分類可搬到另一個主分類
  if (node.kind === "subcategory" && has("parent_id")) {
    const pid = str(input.parent_id, 40);
    if (pid && pid !== node.parent_id) {
      const p = await getNode(env, pid);
      if (p.kind !== "category") throw new HttpError(400, "bad_parent", "只可以搬到主分類");
      await assertUniqueName(env, "subcategory", pid, renamed?.to ?? node.name, id);
      sets.push("parent_id = ?");
      binds.push(pid);
      movedTo = p;
    }
  }
  if (node.kind === "attribute") {
    if (has("multi")) {
      sets.push("multi = ?");
      binds.push(input.multi ? 1 : 0);
    }
    if (has("max_select")) {
      const m = Number(input.max_select);
      sets.push("max_select = ?");
      binds.push(Number.isInteger(m) && m > 0 ? m : null);
    }
    if (has("show_for")) {
      sets.push("show_for = ?");
      binds.push(cleanShowFor(input.show_for));
    }
  }
  if (!sets.length) return { node, garments_updated: 0 };
  sets.push("updated_at = ?");
  binds.push(nowIso());
  await env.DB.prepare(`UPDATE taxonomy SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();

  let changed = 0;
  if (renamed) changed += await cascadeRename(env, node, renamed.from, renamed.to);
  if (movedTo && node.parent_id) {
    // 子分類搬到另一個主分類：使用這個子分類的衣物一併轉到新主分類
    const oldParent = await getNode(env, node.parent_id);
    const r = await env.DB.prepare("UPDATE garments SET category = ?, updated_at = ?, version = version + 1 WHERE category = ? AND subcategory = ?")
      .bind(movedTo.name, nowIso(), oldParent.name, renamed?.to ?? node.name)
      .run();
    changed += r.meta.changes ?? 0;
  }
  invalidateTaxonomy();
  await audit(env, actor, "taxonomy.update", id, { renamed, moved_to: movedTo?.id, garments_updated: changed });
  return { node: await getNode(env, id), garments_updated: changed };
}

/** 改名：已入庫衣物使用舊名稱的，一併改為新名稱 */
async function cascadeRename(env: Env, node: TaxNode, from: string, to: string): Promise<number> {
  const now = nowIso();
  if (node.kind === "category") {
    const r = await env.DB.prepare("UPDATE garments SET category = ?, updated_at = ?, version = version + 1 WHERE category = ?").bind(to, now, from).run();
    return r.meta.changes ?? 0;
  }
  if (node.kind === "subcategory") {
    const parent = node.parent_id ? await getNode(env, node.parent_id) : null;
    const r = await env.DB.prepare(
      "UPDATE garments SET subcategory = ?, updated_at = ?, version = version + 1 WHERE subcategory = ? AND (category = ? OR category IS NULL)",
    )
      .bind(to, now, from, parent?.name ?? "")
      .run();
    return r.meta.changes ?? 0;
  }
  if (node.kind !== "option" || !node.parent_id) return 0;
  const attr = node.parent_id;
  const like = `%${from.replace(/[%_]/g, "")}%`;
  const stmts: D1PreparedStatement[] = [];
  const swap = (list: string[]) => [...new Set(list.map((x) => (x === from ? to : x)))];
  if (isColumnAttribute(attr)) {
    const { results } = await env.DB.prepare(`SELECT id, ${attr} AS v FROM garments WHERE ${attr} LIKE ?`).bind(like).all<{ id: string; v: string | null }>();
    for (const r of results) {
      if (attr === "secondary_colors") {
        const list = parseJsonArray(r.v);
        if (!list.includes(from)) continue;
        stmts.push(env.DB.prepare("UPDATE garments SET secondary_colors = ?, updated_at = ?, version = version + 1 WHERE id = ?").bind(JSON.stringify(swap(list)), now, r.id));
      } else {
        const list = splitMulti(r.v);
        if (!list.includes(from)) continue;
        stmts.push(env.DB.prepare(`UPDATE garments SET ${attr} = ?, updated_at = ?, version = version + 1 WHERE id = ?`).bind(joinMulti(swap(list)), now, r.id));
      }
    }
  } else {
    const { results } = await env.DB.prepare("SELECT id, attributes FROM garments WHERE attributes LIKE ?").bind(like).all<{ id: string; attributes: string | null }>();
    for (const r of results) {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(r.attributes || "{}");
      } catch {
        continue;
      }
      const v = obj[attr];
      if (Array.isArray(v) && v.includes(from)) obj[attr] = swap(v.map(String));
      else if (v === from) obj[attr] = to;
      else continue;
      stmts.push(env.DB.prepare("UPDATE garments SET attributes = ?, updated_at = ?, version = version + 1 WHERE id = ?").bind(JSON.stringify(obj), now, r.id));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

/** 刪除字典項目（連同其下的子分類／選項）。已入庫衣物保留原來的文字，不會被改動。 */
export async function deleteTaxNode(env: Env, actor: Actor, id: string) {
  const node = await getNode(env, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM taxonomy WHERE parent_id = ?").bind(id),
    env.DB.prepare("DELETE FROM taxonomy WHERE id = ?").bind(id),
  ]);
  invalidateTaxonomy();
  await audit(env, actor, "taxonomy.delete", id, { kind: node.kind, name: node.name });
  return { ok: true };
}

/** 排序：ids 為同一層的項目，按陣列次序寫入 sort_order */
export async function reorderTaxNodes(env: Env, actor: Actor, ids: unknown) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw new HttpError(400, "bad_ids", "需要 ids 陣列");
  const list = ids.map(String);
  const now = nowIso();
  await env.DB.batch(list.map((id, i) => env.DB.prepare("UPDATE taxonomy SET sort_order = ?, updated_at = ? WHERE id = ?").bind(i, now, id)));
  invalidateTaxonomy();
  await audit(env, actor, "taxonomy.reorder", undefined, { count: list.length });
  return { ok: true };
}
