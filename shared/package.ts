/**
 * Phase 3.9B.2：衣物及人物模組套件（版本化 ZIP）的格式及驗證（瀏覽器及測試共用）。
 *
 * ZIP 內容：manifest.json＋files/…（圖片）。manifest 記錄格式版本、套件類型、每個檔案的 SHA-256、大小及 MIME、
 * 衣物資料（不含私人欄位，除非匯出時選擇）、衣服設定（按身體模型）、套裝部件，及頭部／髮型素材。
 * 套件內的圖片引用寫成 "pkg:<路徑>"；匯入時換成新建立的檔案 ID（"file:<新 ID>"），全部資料都是獨立副本。
 * 驗證失敗的套件不會寫入任何資料。
 */
import { safePath } from "./zip";

export const PACKAGE_FORMAT = "ai-wardrobe-package", PACKAGE_VERSION = 1;
export const MAX_GARMENTS = 100, MAX_ASSETS = 60, MAX_TEMPLATES = 8;
export type PackageType = "garments" | "character";
export interface PkgFile { sha256: string; size: number; mime: "image/png" | "image/webp" | "image/jpeg" }
export interface PkgTemplate { avatar_id: string; model_name?: string; slot: string | null; fit: unknown; data: unknown }
export interface PkgPart { key: string; name: string; config: unknown; files: string[] }
export interface PkgGarment {
  key: string; name: string; category: string | null; subcategory: string | null; brand: string | null; primary_color: string | null; secondary_colors: string | null;
  style: string | null; season: string | null; pattern: string | null; attributes: Record<string, unknown> | null; price?: number | null; notes?: string | null;
  images: { path: string; type: "processed" | "original"; primary: boolean }[];
  templates: PkgTemplate[]; parts: PkgPart[];
}
export interface PkgAsset { key: string; kind: "head" | "hair"; name: string; category: string | null; config: unknown; files: string[] }
export interface PackageManifest { format: string; format_version: number; package_type: PackageType; created_at: string; title: string; note?: string | null; garments: PkgGarment[]; assets: PkgAsset[]; files: Record<string, PkgFile> }

const MIME_EXT: Record<string, PkgFile["mime"]> = { png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg" };
export const mimeOfPath = (p: string): PkgFile["mime"] | null => MIME_EXT[p.split(".").pop()?.toLowerCase() ?? ""] ?? null;
const s = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
/** "pkg:<路徑>" 引用（深層） */
export function pkgRefs(v: unknown): string[] {
  const out = new Set<string>();
  JSON.stringify(v ?? null, (_k, x) => { if (typeof x === "string" && x.startsWith("pkg:")) out.add(x.slice(4)); return x; });
  return [...out];
}
/** 把 "pkg:<路徑>" 換成匯入後的引用；缺少對應＝拋出錯誤 */
export function remapRefs<T>(v: T, map: Map<string, string>): T {
  return JSON.parse(JSON.stringify(v ?? null), (_k, x) => {
    if (typeof x !== "string" || !x.startsWith("pkg:")) return x;
    const got = map.get(x.slice(4));
    if (!got) throw new Error(`套件引用了不存在的檔案：${x.slice(4)}`);
    return got;
  });
}

export interface Validation { ok: boolean; errors: string[]; warnings: string[]; manifest: PackageManifest | null }
/** 驗證 manifest（結構、版本、數量、路徑、檔案清單、引用完整性）；zipPaths＝ZIP 內實際的檔案 */
export function validateManifest(raw: unknown, zipPaths: Set<string>): Validation {
  const errors: string[] = [], warnings: string[] = [];
  const fail = (m: string): Validation => ({ ok: false, errors: [...errors, m], warnings, manifest: null });
  if (!raw || typeof raw !== "object") return fail("manifest.json 不是有效的資料");
  const m = raw as Record<string, unknown>;
  if (m.format !== PACKAGE_FORMAT) return fail("這不是 AI Wardrobe 套件");
  if (typeof m.format_version !== "number" || !Number.isInteger(m.format_version) || m.format_version < 1) return fail("套件版本不正確");
  if (m.format_version > PACKAGE_VERSION) return fail(`這個套件需要較新版本的 App（套件版本 ${m.format_version}，App 支援 ${PACKAGE_VERSION}）`);
  if (m.package_type !== "garments" && m.package_type !== "character") return fail("套件類型不正確");
  const garmentsIn = Array.isArray(m.garments) ? m.garments : [], assetsIn = Array.isArray(m.assets) ? m.assets : [];
  if (garmentsIn.length > MAX_GARMENTS) return fail(`衣物太多（上限 ${MAX_GARMENTS} 件）`);
  if (assetsIn.length > MAX_ASSETS) return fail(`素材太多（上限 ${MAX_ASSETS} 個）`);
  if (!garmentsIn.length && !assetsIn.length) return fail("套件是空的");
  // 檔案清單：路徑安全、MIME 與副檔名一致、SHA-256 格式、ZIP 內必須存在；ZIP 內不可有清單以外的檔案
  const filesIn = m.files && typeof m.files === "object" ? (m.files as Record<string, Record<string, unknown>>) : {};
  const files: Record<string, PkgFile> = {};
  for (const [p, f] of Object.entries(filesIn)) {
    if (!safePath(p) || !p.startsWith("files/")) return fail(`不安全的檔案路徑：${p.slice(0, 60)}`);
    const mime = mimeOfPath(p);
    if (!mime || f?.mime !== mime) return fail(`不支援的檔案類型：${p}`);
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256) || typeof f.size !== "number" || f.size <= 0 || f.size > 25 * 1024 * 1024) return fail(`檔案資料不正確：${p}`);
    if (!zipPaths.has(p)) return fail(`套件缺少檔案：${p}`);
    files[p] = { sha256: f.sha256, size: f.size, mime };
  }
  for (const p of zipPaths) if (p !== "manifest.json" && !files[p]) return fail(`套件包含未登記的檔案：${p.slice(0, 60)}`);
  const need = (p: unknown, where: string) => { if (typeof p !== "string" || !files[p]) throw new Error(`${where} 引用了不存在的檔案`); return p; };
  const keys = new Set<string>();
  const key = (v: unknown, prefix: string) => { const k = typeof v === "string" && /^[\w-]{1,40}$/.test(v) ? v : null; if (!k || keys.has(k)) throw new Error(`${prefix} 識別不正確或重複`); keys.add(k); return k; };
  try {
    const garments: PkgGarment[] = garmentsIn.map((g0, i) => {
      const g = (g0 ?? {}) as Record<string, unknown>;
      const imgs = Array.isArray(g.images) ? g.images.slice(0, 12) : [];
      if (!imgs.length) throw new Error(`第 ${i + 1} 件衣物沒有圖片`);
      const templates = (Array.isArray(g.templates) ? g.templates : []).slice(0, MAX_TEMPLATES).map((t0) => { const t = (t0 ?? {}) as Record<string, unknown>; const avatar = s(t.avatar_id, 64); if (!avatar || !/^[\w-]+$/.test(avatar)) throw new Error("衣服設定的身體模型不正確"); for (const r of pkgRefs(t.data)) need(r, "衣服設定"); return { avatar_id: avatar, model_name: s(t.model_name, 60) ?? undefined, slot: s(t.slot, 24), fit: t.fit ?? null, data: t.data ?? null }; });
      const parts = (Array.isArray(g.parts) ? g.parts : []).slice(0, 20).map((p0) => { const p = (p0 ?? {}) as Record<string, unknown>; const fl = (Array.isArray(p.files) ? p.files : []).map((f) => need(f, "套裝部件")); for (const r of pkgRefs(p.config)) need(r, "套裝部件"); return { key: key(p.key, "部件"), name: s(p.name, 60) ?? "部件", config: p.config ?? null, files: fl }; });
      const price = typeof g.price === "number" && Number.isFinite(g.price) && g.price >= 0 ? Math.round(g.price * 100) / 100 : undefined;
      return {
        key: key(g.key, "衣物"), name: s(g.name, 120) ?? `匯入衣物 ${i + 1}`, category: s(g.category, 40), subcategory: s(g.subcategory, 40), brand: s(g.brand, 60), primary_color: s(g.primary_color, 60), secondary_colors: s(g.secondary_colors, 120),
        style: s(g.style, 120), season: s(g.season, 60), pattern: s(g.pattern, 60), attributes: g.attributes && typeof g.attributes === "object" && !Array.isArray(g.attributes) ? (g.attributes as Record<string, unknown>) : null,
        ...(price !== undefined ? { price } : {}), ...(s(g.notes, 2000) ? { notes: s(g.notes, 2000) } : {}),
        images: imgs.map((x0, j) => { const x = (x0 ?? {}) as Record<string, unknown>; return { path: need(x.path, "衣物圖片"), type: x.type === "original" ? "original" as const : "processed" as const, primary: x.primary === true || j === 0 }; }),
        templates, parts,
      };
    });
    const assets: PkgAsset[] = assetsIn.map((a0) => {
      const a = (a0 ?? {}) as Record<string, unknown>;
      if (a.kind !== "head" && a.kind !== "hair") throw new Error("素材類型不正確（只支援頭部及髮型）");
      const fl = (Array.isArray(a.files) ? a.files : []).slice(0, 40).map((f) => need(f, "素材"));
      if (!fl.length) throw new Error("素材沒有圖片");
      for (const r of pkgRefs(a.config)) if (!fl.includes(r)) throw new Error("素材設定引用了不屬於它的圖片");
      for (const f of fl) if (files[f].mime === "image/jpeg") throw new Error("角色素材必須是透明 PNG 或 WebP");
      return { key: key(a.key, "素材"), kind: a.kind, name: s(a.name, 60) ?? "匯入素材", category: s(a.category, 30), config: a.config ?? null, files: fl };
    });
    if (garments.some((g) => g.price !== undefined || g.notes)) warnings.push("套件包含價格或備註（由分享者選擇加入）");
    if (garments.some((g) => g.images.some((x) => x.type === "original"))) warnings.push("套件包含原始相片");
    return { ok: true, errors, warnings, manifest: { format: PACKAGE_FORMAT, format_version: m.format_version, package_type: m.package_type, created_at: s(m.created_at, 40) ?? "", title: s(m.title, 80) ?? "未命名套件", note: s(m.note, 500), garments, assets, files } };
  } catch (e) { return fail((e as Error).message); }
}

/** 衣服設定的模型相容性：同一身體模型（Avatar V2 或匯入端已有、名稱相同的模型）＝直接套用；否則只匯入圖片並標示需要校正 */
export type Compat = "same" | "needs_calibration";
export function compatOf(t: PkgTemplate, available: { id: string; name: string }[]): { compat: Compat; target: string | null } {
  if (t.avatar_id === "avatar_v2") return { compat: "same", target: "avatar_v2" };
  const byId = available.find((m) => m.id === t.avatar_id);
  if (byId) return { compat: "same", target: byId.id };
  return { compat: "needs_calibration", target: null };
}
