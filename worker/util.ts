export interface Env {
  DB: D1Database;
  THUMBNAIL_SERVER_ENCODING?: string;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  MAX_UPLOAD_MB?: string;
  TOKEN_DAILY_CALL_LIMIT?: string;
  TOKEN_DAILY_UPLOAD_MB?: string;
  UPLOAD_LINK_MAX_MINUTES?: string;
}

/** 已驗證的呼叫者 */
export interface Actor {
  kind: "session" | "token" | "ticket";
  id: string; // user id / token id / ticket hash
  scopes: Set<string>;
  label: string;
}

export const ALL_SCOPES = ["read", "import", "upload", "update"] as const;

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status);
  }
  console.error("Unhandled error", err);
  return json({ error: { code: "internal", message: "伺服器內部錯誤" } }, 500);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayHk(): string {
  // 以香港時間計算每日用量
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${toBase32(bytes)}`;
}

export function randomToken(bytesLen = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(bytesLen));
  return toBase64Url(bytes);
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function toBase32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const input = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", input instanceof Uint8Array ? new Uint8Array(input).buffer : input));
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function readJson<T = Record<string, unknown>>(req: Request, maxBytes = 1_000_000): Promise<T> {
  const len = Number(req.headers.get("content-length") || "0");
  if (len > maxBytes) throw new HttpError(413, "payload_too_large", "請求內容過大");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "payload_too_large", "請求內容過大");
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "bad_json", "JSON 格式錯誤");
  }
}

export function requireScope(actor: Actor, scope: string): void {
  if (actor.kind === "session") return;
  if (!actor.scopes.has(scope)) {
    throw new HttpError(403, "forbidden", `此權杖沒有「${scope}」權限`);
  }
}

export function requireSession(actor: Actor): void {
  if (actor.kind !== "session") throw new HttpError(403, "forbidden", "此操作只限已登入的 App 使用者");
}

export function str(v: unknown, max = 500): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

export function strArray(v: unknown, maxItems = 10): string[] | null {
  if (v === undefined || v === null || v === "") return null;
  const arr = Array.isArray(v) ? v : String(v).split(/[,，、]/);
  const cleaned = arr.map((x) => String(x).trim()).filter(Boolean).slice(0, maxItems);
  return cleaned.length ? cleaned : null;
}

export function parseJsonArray(v: unknown): string[] {
  if (typeof v !== "string" || !v) return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
}

export async function audit(env: Env, actor: Actor | string, action: string, target?: string, detail?: unknown) {
  const who = typeof actor === "string" ? actor : `${actor.kind}:${actor.label}`;
  try {
    await env.DB.prepare("INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?,?,?,?,?)")
      .bind(nowIso(), who, action, target ?? null, detail === undefined ? null : JSON.stringify(detail).slice(0, 2000))
      .run();
  } catch (e) {
    console.error("audit failed", e);
  }
}

export function intVar(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}
