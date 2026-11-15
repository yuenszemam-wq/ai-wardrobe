/**
 * Phase 3.9B.2：衣物及人物模組套件的匯出及匯入（在手機執行；伺服器逐項再驗證）。
 *
 * 匯出：衣物資料（預設不含價格、備註）、去背透明圖（可選原始相片）、各身體模型的衣服設定、套裝部件；或頭部／髮型素材。
 * 匯入流程：讀取 → 驗證（ZIP 安全、manifest 結構及版本、檔案清單、SHA-256、圖片格式）→ 預覽（數量、相容性、提示）→
 * 使用者確認 → 逐項建立「獨立副本」（全部新 ID；檔案引用換成新檔案）→ 任何一步失敗即刪除這次已建立的資料（補償）。
 * 衣服設定：同一身體模型直接套用；其他身體只匯入圖片並標示需要校正。
 */
import { api, ApiError, uploadImage } from "./api";
import { PACKAGE_FORMAT, PACKAGE_VERSION, PackageManifest, PkgAsset, PkgFile, PkgGarment, PkgTemplate, compatOf, mimeOfPath, pkgRefs, remapRefs, validateManifest } from "../shared/package";
import { DEFAULT_LIMITS, ZipEntry, bytesOf, readZip, textOf, writeZip } from "../shared/zip";

const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
async function bytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`讀取圖片失敗（${r.status}）`);
  return new Uint8Array(await r.arrayBuffer());
}
const extOf = (mime: string) => (mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg");
/** "file:<id>" → "pkg:files/<id>.<ext>"（收集需要打包的檔案） */
function packRefs<T>(v: T, files: Map<string, string>): T {
  return JSON.parse(JSON.stringify(v ?? null), (_k, x) => {
    if (typeof x !== "string" || !/^file:d[am]f_[a-z2-7]+$/.test(x)) return x;
    const id = x.slice(5), path = `files/${id}.png`;
    files.set(path, `/api/doll/files/${id}`);
    return "pkg:" + path;
  });
}
async function build(manifest: Omit<PackageManifest, "files">, urls: Map<string, string>, onProgress?: (d: number, t: number) => void): Promise<Blob> {
  const entries: ZipEntry[] = [], files: Record<string, PkgFile> = {};
  let n = 0;
  for (const [path, url] of urls) {
    const b = await bytes(url);
    // 實際格式以檔案內容判斷（副檔名跟隨內容）
    const mime: PkgFile["mime"] = b[0] === 0x89 && b[1] === 0x50 ? "image/png" : b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : "image/webp";
    const real = path.replace(/\.\w+$/, "." + extOf(mime));
    entries.push({ path: real, data: b });
    files[real] = { sha256: await hex(b), size: b.length, mime };
    if (real !== path) for (const g of manifest.garments) { for (const im of g.images) if (im.path === path) im.path = real; }
    onProgress?.(++n, urls.size);
  }
  // 引用的路徑亦跟隨實際副檔名
  const fixed = JSON.parse(JSON.stringify(manifest), (_k, x) => (typeof x === "string" && x.startsWith("pkg:files/") && !files[x.slice(4)] ? "pkg:" + Object.keys(files).find((p) => p.replace(/\.\w+$/, "") === x.slice(4).replace(/\.\w+$/, "")) : x));
  entries.unshift({ path: "manifest.json", data: bytesOf(JSON.stringify({ ...fixed, files }, null, 1)) });
  return new Blob([writeZip(entries) as BlobPart], { type: "application/zip" });
}

interface GImage { id: string; image_type: string; mime_type: string; is_primary?: boolean | number; has_alpha?: boolean | number }
export interface ExportOptions { originals: boolean; privateFields: boolean }
export async function exportGarments(ids: string[], opts: ExportOptions, onProgress?: (d: number, t: number) => void): Promise<{ blob: Blob; name: string }> {
  const models = [{ id: "avatar_v2", name: "Avatar V2" }, ...((await api<{ models: { id: string; name: string }[] }>("/api/doll/models").catch(() => ({ models: [] }))).models)];
  const tplBy = new Map<string, Map<string, Record<string, unknown>>>();
  for (const m of models) {
    const r = await api<{ templates: Record<string, unknown>[] }>("/api/doll/templates" + (m.id === "avatar_v2" ? "" : `?avatar=${encodeURIComponent(m.id)}`)).catch(() => ({ templates: [] }));
    tplBy.set(m.id, new Map(r.templates.filter((t) => t.avatar_id === m.id).map((t) => [String(t.garment_id), t])));
  }
  const urls = new Map<string, string>();
  const garments: PkgGarment[] = [];
  for (const [i, id] of ids.entries()) {
    const g = await api<Record<string, unknown> & { images: GImage[] }>(`/api/garments/${id}`);
    const imgs = g.images.filter((im) => im.image_type !== "thumbnail" && !/heic|heif/.test(im.mime_type) && (im.image_type === "processed" ? !!im.has_alpha : opts.originals));
    if (!imgs.length) continue; // 沒有可分享的圖片（未去背且未選擇原始相片）
    imgs.sort((a, b) => Number(b.image_type === "processed") - Number(a.image_type === "processed") || Number(!!b.is_primary) - Number(!!a.is_primary));
    const images = imgs.map((im, j) => { const path = `files/${im.id}.${extOf(im.mime_type)}`; urls.set(path, `/api/images/${im.id}`); return { path, type: im.image_type === "processed" ? "processed" as const : "original" as const, primary: j === 0 }; });
    const templates: PkgTemplate[] = [];
    for (const m of models) { const t = tplBy.get(m.id)?.get(id); if (t) templates.push({ avatar_id: m.id, model_name: m.name, slot: (t.slot as string | null) ?? null, fit: t.fit, data: packRefs(t.data, urls) }); }
    const parts = (await api<{ assets: { id: string; name: string; config: unknown; files: { id: string }[] }[] }>(`/api/doll/assets?kind=garment_part&garment_id=${id}`).catch(() => ({ assets: [] }))).assets
      .map((a) => ({ key: "p" + a.id.slice(4, 14), name: a.name, config: packRefs(a.config, urls), files: a.files.map((f) => { const path = `files/${f.id}.png`; urls.set(path, `/api/doll/files/${f.id}`); return path; }) }));
    garments.push({
      key: "g" + (i + 1), name: String(g.name ?? ""), category: (g.category as string) ?? null, subcategory: (g.subcategory as string) ?? null, brand: (g.brand as string) ?? null, primary_color: (g.primary_color as string) ?? null, secondary_colors: (g.secondary_colors as string) ?? null,
      style: (g.style as string) ?? null, season: (g.season as string) ?? null, pattern: (g.pattern as string) ?? null, attributes: (typeof g.attributes === "string" ? (() => { try { return JSON.parse(g.attributes as string); } catch { return null; } })() : (g.attributes as Record<string, unknown>)) ?? null,
      ...(opts.privateFields ? { price: (g.price as number) ?? null, notes: (g.notes as string) ?? null } : {}),
      images, templates, parts,
    });
  }
  if (!garments.length) throw new Error("選擇的衣物沒有可分享的去背圖（可選擇包含原始相片）");
  const blob = await build({ format: PACKAGE_FORMAT, format_version: PACKAGE_VERSION, package_type: "garments", created_at: new Date().toISOString(), title: garments.length === 1 ? garments[0].name : `${garments.length} 件衣物`, garments, assets: [] }, urls, onProgress);
  return { blob, name: `${garments.length === 1 ? garments[0].name : "衣物套件"}.awpkg.zip` };
}
export async function exportCharacterAssets(ids: string[], onProgress?: (d: number, t: number) => void): Promise<{ blob: Blob; name: string }> {
  const all = (await api<{ assets: { id: string; kind: string; name: string; category: string | null; config: unknown; files: { id: string }[] }[] }>("/api/doll/assets")).assets;
  const urls = new Map<string, string>();
  const assets: PkgAsset[] = all.filter((a) => ids.includes(a.id) && (a.kind === "head" || a.kind === "hair")).map((a, i) => ({
    key: "a" + (i + 1), kind: a.kind as "head" | "hair", name: a.name, category: a.category, config: packRefs(a.config, urls),
    files: a.files.map((f) => { const path = `files/${f.id}.png`; urls.set(path, `/api/doll/files/${f.id}`); return path; }),
  }));
  if (!assets.length) throw new Error("請選擇頭部或髮型素材");
  const blob = await build({ format: PACKAGE_FORMAT, format_version: PACKAGE_VERSION, package_type: "character", created_at: new Date().toISOString(), title: assets.length === 1 ? assets[0].name : `${assets.length} 個角色素材`, garments: [], assets }, urls, onProgress);
  return { blob, name: `${assets.length === 1 ? assets[0].name : "角色素材"}.awpkg.zip` };
}

// ───── 匯入 ─────
export interface ImportPreview { manifest: PackageManifest; files: Map<string, Uint8Array>; warnings: string[]; compat: { garment: string; model: string; compat: "same" | "needs_calibration" }[] }
const MAGIC: Record<PkgFile["mime"], (b: Uint8Array) => boolean> = {
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
  "image/webp": (b) => b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45,
};
/** 讀取及驗證（不會寫入任何資料） */
export async function inspectPackage(file: Blob): Promise<ImportPreview> {
  if (file.size > DEFAULT_LIMITS.maxTotal) throw new Error("套件太大（上限 200 MB）");
  const files = await readZip(new Uint8Array(await file.arrayBuffer()));
  const raw = files.get("manifest.json");
  if (!raw) throw new Error("套件缺少 manifest.json");
  let parsed: unknown;
  try { parsed = JSON.parse(textOf(raw)); } catch { throw new Error("manifest.json 格式錯誤"); }
  const v = validateManifest(parsed, new Set(files.keys()));
  if (!v.ok || !v.manifest) throw new Error(v.errors[0] ?? "套件驗證失敗");
  for (const [path, f] of Object.entries(v.manifest.files)) {
    const b = files.get(path)!;
    if (b.length !== f.size || (await hex(b)) !== f.sha256) throw new Error(`檔案校驗失敗（可能已損壞或被修改）：${path}`);
    if (!MAGIC[f.mime](b) || mimeOfPath(path) !== f.mime) throw new Error(`圖片格式與記錄不符：${path}`);
  }
  const models = [{ id: "avatar_v2", name: "Avatar V2" }, ...((await api<{ models: { id: string; name: string }[] }>("/api/doll/models").catch(() => ({ models: [] }))).models)];
  const compat = v.manifest.garments.flatMap((g) => g.templates.map((t) => ({ garment: g.name, model: t.model_name ?? t.avatar_id, compat: compatOf(t, models).compat })));
  const warnings = [...v.warnings];
  if (compat.some((c) => c.compat === "needs_calibration")) warnings.push("部分衣服設定屬於這部裝置沒有的身體模型：只匯入圖片，需要重新校正");
  return { manifest: v.manifest, files, warnings, compat };
}

export interface ImportResult { garments: string[]; assets: string[]; skipped_templates: number; applied_templates: number }
/** 建立獨立副本；任何一步失敗即刪除這次已建立的資料 */
export async function commitImport(p: ImportPreview, onProgress?: (msg: string) => void): Promise<ImportResult> {
  const run = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const created = { garments: [] as string[], assets: [] as string[] };
  const res: ImportResult = { garments: created.garments, assets: created.assets, skipped_templates: 0, applied_templates: 0 };
  const blobOf = (path: string) => new Blob([p.files.get(path)! as BlobPart], { type: p.manifest.files[path].mime });
  const upAsset = async (kind: string, name: string, category: string | null, garmentId: string | null, files: string[], config: unknown, map: Map<string, string>) => {
    const a = await api<{ id: string }>("/api/doll/assets", { method: "POST", json: { kind, name, category, ...(garmentId ? { garment_id: garmentId } : {}) } });
    created.assets.push(a.id);
    for (const f of files) { const r = await api<{ ref: string }>(`/api/doll/assets/${a.id}/files`, { method: "POST", body: blobOf(f), headers: { "content-type": p.manifest.files[f].mime } }); map.set(f, r.ref); }
    if (config != null) await api(`/api/doll/assets/${a.id}`, { method: "PATCH", json: { config: remapRefs(config, map) } });
    return a.id;
  };
  const models = [{ id: "avatar_v2", name: "Avatar V2" }, ...((await api<{ models: { id: string; name: string }[] }>("/api/doll/models").catch(() => ({ models: [] }))).models)];
  try {
    for (const a of p.manifest.assets) { onProgress?.(`匯入素材「${a.name}」`); await upAsset(a.kind, a.name, a.category, null, a.files, a.config, new Map()); }
    for (const g of p.manifest.garments) {
      onProgress?.(`匯入衣物「${g.name}」`);
      const body: Record<string, unknown> = { name: g.name, category: g.category, subcategory: g.subcategory, brand: g.brand, primary_color: g.primary_color, secondary_colors: g.secondary_colors, style: g.style, season: g.season, pattern: g.pattern, ...(g.attributes ? { attributes: g.attributes } : {}), ...(g.price != null ? { price: g.price } : {}), ...(g.notes ? { notes: g.notes } : {}), client_key: `pkg-${run}-${g.key}` };
      const made = await api<{ id: string }>("/api/garments", { method: "POST", json: body });
      created.garments.push(made.id);
      let transparent: string | null = null;
      for (const im of g.images) {
        const r = await uploadImage("/api/images/upload", { garment_id: made.id, image_type: im.type, ...(im.primary ? { is_primary: "1" } : {}) }, blobOf(im.path), im.path.split("/").pop() || "image");
        if (im.type === "processed" && !transparent) transparent = r.id;
      }
      const map = new Map<string, string>();
      for (const part of g.parts) await upAsset("garment_part", part.name, null, made.id, part.files, part.config, map);
      for (const t of g.templates) {
        const c = compatOf(t, models);
        if (c.compat !== "same" || !c.target) { res.skipped_templates++; continue; }
        // 衣服設定內引用的部件圖片：沒有在部件中的引用以獨立檔案補上（不會失效）
        for (const r of pkgRefs(t.data)) if (!map.has(r)) await upAsset("garment_part", "設定圖片", null, made.id, [r], null, map);
        await api(`/api/doll/templates/${made.id}`, { method: "PUT", json: { avatar_id: c.target, fit: t.fit, slot: t.slot, image_id: transparent, expected_version: 0, data: remapRefs(t.data, map) } });
        res.applied_templates++;
      }
    }
    return res;
  } catch (e) {
    onProgress?.("匯入失敗，正在移除這次已建立的資料…");
    for (const id of [...created.garments].reverse()) await api(`/api/garments/${id}`, { method: "DELETE" }).catch(() => undefined);
    for (const id of [...created.assets].reverse()) await api(`/api/doll/assets/${id}`, { method: "DELETE" }).catch(() => undefined);
    throw new Error(`${(e as Error).message}（已移除這次匯入的 ${created.garments.length} 件衣物及 ${created.assets.length} 個素材，衣櫃沒有改變）`);
  }
}
export { ApiError };
