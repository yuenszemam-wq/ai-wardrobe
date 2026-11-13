// 角色套件（Phase 3.6C）：把自訂身體匯出／匯入為 ZIP。
// 套件內容：model.json（格式、名稱、與 Avatar V2 不同的部件／關節／錨點／圖層／頭部對位）、parts/*.png（替換的身體部件）、
// 可選 thumb.jpg、可選 head.png（獨立頭部，匯入時建立頭部素材）。圖片引用只可以指向套件內的檔案，
// 匯入前先完整驗證（部件名稱、骨骼、座標、圖片格式及大小），驗證失敗不會建立任何資料。
import { ModelDef, ModelError, normalizeModelDef } from "../../shared/avatarModel";
import { api } from "../api";
import { prepareAsset } from "./content";
import { getModel } from "./models";

export const PACKAGE_FORMAT = "ai-wardrobe-avatar-model";
const MAX_ZIP = 80 * 1024 * 1024, MAX_ENTRY = 12 * 1024 * 1024, MAX_ENTRIES = 120, MAX_TOTAL = 160 * 1024 * 1024;

// ───── ZIP（只用 store 寫入；讀取支援 store 及 deflate） ─────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(d: Uint8Array) { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function writeZip(files: { name: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder(), chunks: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true);
    h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    chunks.push(new Uint8Array(h.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(e.buffer)].map((u) => u.slice().buffer as ArrayBuffer), { type: "application/zip" });
}
async function inflate(data: Uint8Array, size: number): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const out = new Uint8Array(await new Response(new Blob([data.slice().buffer as ArrayBuffer]).stream().pipeThrough(ds)).arrayBuffer());
  if (out.length !== size) throw new Error("套件內的檔案損壞");
  return out;
}
export async function readZip(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  if (buf.byteLength > MAX_ZIP) throw new Error("套件太大（上限 80 MB）");
  const u = new Uint8Array(buf), v = new DataView(buf);
  let eocd = -1;
  for (let i = u.length - 22; i >= Math.max(0, u.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("這不是有效的 ZIP 檔案");
  const count = v.getUint16(eocd + 10, true), start = v.getUint32(eocd + 16, true);
  if (count > MAX_ENTRIES) throw new Error("套件內的檔案太多");
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  let p = start, total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > u.length || v.getUint32(p, true) !== 0x02014b50) throw new Error("ZIP 目錄損壞");
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
    const name = dec.decode(u.subarray(p + 46, p + 46 + nlen)).replace(/\\/g, "/").replace(/^\.\//, "");
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || /(^|\/)\./.test(name)) continue;
    if (name.includes("..") || name.startsWith("/")) throw new Error("套件含有不安全的檔案路徑");
    if (size > MAX_ENTRY) throw new Error(`「${name}」超過 12 MB 上限`);
    total += size;
    if (total > MAX_TOTAL) throw new Error("套件解壓後太大");
    if (v.getUint32(local, true) !== 0x04034b50) throw new Error("ZIP 檔案損壞");
    const off = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = u.subarray(off, off + csize);
    if (raw.length !== csize) throw new Error("ZIP 檔案不完整");
    out.set(name, method === 0 ? raw.slice() : method === 8 ? await inflate(raw, size) : (() => { throw new Error("不支援的壓縮方式"); })());
  }
  return out;
}

const isImage = (b: Uint8Array) => (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45);
const safeName = (s: string) => (s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "角色").slice(0, 40);

export async function exportModelPackage(id: string) {
  const m = await getModel(id);
  const files: { name: string; data: Uint8Array }[] = [];
  const def: ModelDef = JSON.parse(JSON.stringify(m.def));
  for (const [part, p] of Object.entries(def.parts)) {
    if (!p.file?.startsWith("file:")) continue;
    const res = await fetch(`/api/doll/files/${p.file.slice(5)}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error("部件圖片未能讀取");
    const b = new Uint8Array(await res.arrayBuffer());
    const path = `parts/${part}.${b[0] === 0x89 ? "png" : "webp"}`;
    files.push({ name: path, data: b });
    p.file = path;
  }
  if (m.thumb) { const r = await fetch(m.thumb, { credentials: "same-origin" }).catch(() => null); if (r?.ok) files.push({ name: "thumb.jpg", data: new Uint8Array(await r.arrayBuffer()) }); }
  const json = { format: PACKAGE_FORMAT, version: 1, name: m.name, base: "avatar_v2", canvas: { w: 1200, h: 1800 }, revision: m.revision, exported_at: new Date().toISOString(), def };
  files.unshift({ name: "model.json", data: new TextEncoder().encode(JSON.stringify(json, null, 2)) });
  const blob = writeZip(files), file = new File([blob], `${safeName(m.name)}.zip`, { type: "application/zip" });
  if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }).catch(() => undefined); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

/** 驗證套件（不寫入任何資料）：回傳模型定義及需要上傳的部件圖片 */
export function checkPackage(zip: Map<string, Uint8Array>): { name: string; def: ModelDef; files: Map<string, Uint8Array>; head: Uint8Array | null; thumb: Uint8Array | null } {
  const raw = zip.get("model.json");
  if (!raw) throw new Error("套件缺少 model.json");
  let j: Record<string, unknown>;
  try { j = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new Error("model.json 不是有效的 JSON"); }
  if (j.format !== PACKAGE_FORMAT || j.version !== 1) throw new Error("不支援這個套件格式（需要 AI Wardrobe 角色套件第 1 版）");
  const canvas = j.canvas as { w?: number; h?: number } | undefined;
  if (canvas && (canvas.w !== 1200 || canvas.h !== 1800)) throw new Error("目前只支援 1200×1800 邏輯畫布的角色");
  const d = (j.def ?? {}) as { parts?: Record<string, { file?: unknown }> };
  const files = new Map<string, Uint8Array>();
  const placeholder = JSON.parse(JSON.stringify(d));
  for (const [part, p] of Object.entries(placeholder.parts ?? {}) as [string, { file?: unknown }][]) {
    if (p.file == null) continue;
    if (typeof p.file !== "string" || !/^parts\/[\w-]{1,40}\.(png|webp)$/i.test(p.file)) throw new Error(`部件 ${part} 的圖片必須是套件內 parts/ 資料夾的 PNG／WebP`);
    const bytes = zip.get(p.file);
    if (!bytes) throw new Error(`套件缺少圖片 ${p.file}`);
    if (!isImage(bytes)) throw new Error(`${p.file} 不是 PNG／WebP 圖片`);
    files.set(part, bytes);
    p.file = "file:dmf_aaaaaaaa"; // 只供驗證；上傳後換成實際引用
  }
  let def: ModelDef;
  try { def = normalizeModelDef(placeholder); } catch (e) { throw new Error(e instanceof ModelError ? e.message : "模型資料不正確"); }
  const head = zip.get("head.png") ?? null;
  if (head && !isImage(head)) throw new Error("head.png 不是 PNG 圖片");
  const thumb = zip.get("thumb.jpg") ?? zip.get("thumb.png") ?? null;
  return { name: String(j.name ?? "匯入的角色").slice(0, 40), def, files, head, thumb };
}

/** 匯入：先驗證，再建立模型、上傳部件、保存定義；中途失敗會刪除已建立的模型 */
export async function importModelPackage(file: File): Promise<string> {
  const pkg = checkPackage(await readZip(await file.arrayBuffer()));
  const m = await api<{ id: string }>("/api/doll/models", { method: "POST", json: { name: pkg.name, from: "avatar_v2" } });
  try {
    const def: ModelDef = JSON.parse(JSON.stringify(pkg.def));
    for (const [part, bytes] of pkg.files) {
      const src = def.parts[part].src;
      const q = src ? `?src_w=${src.w}&src_h=${src.h}&x0=${src.crop[0]}&y0=${src.crop[1]}&x1=${src.crop[2]}&y1=${src.crop[3]}` : "";
      const up = await api<{ ref: string }>(`/api/doll/models/${m.id}/files${q}`, { method: "POST", body: new Blob([bytes.slice().buffer as ArrayBuffer]), headers: { "content-type": bytes[0] === 0x89 ? "image/png" : "image/webp" } });
      def.parts[part] = { ...def.parts[part], file: up.ref };
    }
    await api(`/api/doll/models/${m.id}/def`, { method: "PUT", json: { def, expected_revision: 1 } });
    if (pkg.thumb) await api(`/api/doll/models/${m.id}/thumb`, { method: "PUT", body: new Blob([pkg.thumb.slice().buffer as ArrayBuffer]), headers: { "content-type": pkg.thumb[0] === 0x89 ? "image/png" : "image/jpeg" } }).catch(() => undefined);
  } catch (e) {
    await api(`/api/doll/models/${m.id}`, { method: "DELETE" }).catch(() => undefined);
    throw e;
  }
  if (pkg.head) {
    // 獨立頭部：建立頭部素材，放在 Avatar V2 頭部的標準位置（之後可以在換裝頁或身體編輯器調整）
    try {
      const prepared = await prepareAsset(new Blob([pkg.head.slice().buffer as ArrayBuffer], { type: "image/png" }));
      const a = await api<{ id: string }>("/api/doll/assets", { method: "POST", json: { kind: "head", name: `${pkg.name} 頭部` } });
      const up = await api<{ ref: string }>(`/api/doll/assets/${a.id}/files`, { method: "POST", body: prepared.blob, headers: { "content-type": "image/png" } });
      const h = 272, w = h / (prepared.height / prepared.width);
      await api(`/api/doll/assets/${a.id}`, { method: "PATCH", json: { config: { file: up.ref, x: Math.round((601 - w / 2) * 10) / 10, y: 36, w: Math.round(w * 10) / 10, h } } });
      await api(`/api/doll/assets/${a.id}/thumb`, { method: "PUT", body: prepared.thumb, headers: { "content-type": "image/png" } }).catch(() => undefined);
    } catch { /* 頭部失敗不影響身體 */ }
  }
  return m.id;
}
