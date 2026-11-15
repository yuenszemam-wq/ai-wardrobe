/**
 * Phase 3.9B.2：最小 ZIP 讀寫（套件匯出／匯入用；瀏覽器、Worker 及 Node 共用，不依賴第三方套件）。
 * - 寫入：只用「儲存」（不壓縮；圖片本身已壓縮），標準 ZIP，可在電腦或手機的檔案 App 打開。
 * - 讀取：支援儲存（0）及 deflate（8，經 DecompressionStream）。
 * - 安全：條目數量、單檔及總解壓大小上限；拒絕路徑穿越（..、絕對路徑、反斜線、磁碟代號）、重複路徑及加密條目；
 *   所有大小以中央目錄及本地檔頭交叉核對；解壓後大小必須與記錄相同（防 ZIP 炸彈）。
 */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(b: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const enc = new TextEncoder(), dec = new TextDecoder("utf-8", { fatal: true });

export interface ZipEntry { path: string; data: Uint8Array }
export function writeZip(entries: ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    if (!safePath(e.path)) throw new Error(`不安全的檔案路徑：${e.path}`);
    const name = enc.encode(e.path), crc = crc32(e.data), size = e.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, e.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

/** 安全的相對路徑：只允許英數、底線、連字號、點及斜線；不可有 ..、開頭斜線、反斜線或磁碟代號 */
export function safePath(p: string): boolean {
  return typeof p === "string" && p.length > 0 && p.length <= 160 && /^[\w./-]+$/.test(p) && !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "." || s === "") && !/^[a-z]:/i.test(p);
}
export interface ReadLimits { maxEntries: number; maxFile: number; maxTotal: number }
export const DEFAULT_LIMITS: ReadLimits = { maxEntries: 600, maxFile: 25 * 1024 * 1024, maxTotal: 200 * 1024 * 1024 };
async function inflate(data: Uint8Array, expect: number, limit: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("這個瀏覽器不支援壓縮的 ZIP，請以不壓縮方式重新打包");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > limit || n > expect) { await reader.cancel(); throw new Error("ZIP 解壓大小與記錄不符（可能是損壞或惡意檔案）"); } chunks.push(value); }
  const out = new Uint8Array(n); let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
export async function readZip(buf: Uint8Array, limits: ReadLimits = DEFAULT_LIMITS): Promise<Map<string, Uint8Array>> {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("不是有效的 ZIP 檔案");
  const count = v.getUint16(eocd + 10, true), cdSize = v.getUint32(eocd + 12, true), cdOff = v.getUint32(eocd + 16, true);
  if (count > limits.maxEntries) throw new Error(`檔案數量太多（上限 ${limits.maxEntries}）`);
  if (cdOff + cdSize > buf.length) throw new Error("ZIP 目錄損壞");
  const out = new Map<string, Uint8Array>();
  let p = cdOff, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || v.getUint32(p, true) !== 0x02014b50) throw new Error("ZIP 目錄損壞");
    const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
    let path: string;
    try { path = dec.decode(buf.subarray(p + 46, p + 46 + nlen)); } catch { throw new Error("檔案名稱編碼不正確"); }
    p += 46 + nlen + xlen + clen;
    if (path.endsWith("/")) continue; // 資料夾
    if (flags & 1) throw new Error("不支援加密的 ZIP");
    if (!safePath(path)) throw new Error(`不安全的檔案路徑：${path.slice(0, 60)}`);
    if (out.has(path)) throw new Error(`重複的檔案：${path}`);
    if (usize > limits.maxFile) throw new Error(`檔案太大：${path}`);
    total += usize; if (total > limits.maxTotal) throw new Error("套件解壓後太大");
    if (local + 30 > buf.length || v.getUint32(local, true) !== 0x04034b50) throw new Error("ZIP 檔頭損壞");
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    if (start + csize > buf.length) throw new Error("ZIP 內容不完整");
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? (csize === usize ? raw.slice() : (() => { throw new Error("ZIP 大小記錄不符"); })()) : method === 8 ? await inflate(raw, usize, limits.maxFile) : (() => { throw new Error(`不支援的壓縮方式（${method}）`); })();
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`檔案校驗失敗：${path}`);
    out.set(path, data);
  }
  return out;
}
export const textOf = (b: Uint8Array) => dec.decode(b);
export const bytesOf = (s: string) => enc.encode(s);
