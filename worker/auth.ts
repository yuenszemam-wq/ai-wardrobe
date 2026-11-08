import {
  ALL_SCOPES,
  Actor,
  Env,
  HttpError,
  audit,
  intVar,
  json,
  newId,
  nowIso,
  randomToken,
  readJson,
  requireSession,
  sha256Hex,
  str,
  timingSafeEqualStr,
  toHex,
  todayHk,
} from "./util";

const SESSION_COOKIE = "aw_session";
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000; // Workers 上限
const MAX_LOGIN_FAILS_PER_DAY = 20;

// ───────── 密碼雜湊 ─────────
async function pbkdf2(password: string, saltHex: string, iterations: number): Promise<string> {
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return toHex(bits);
}

function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function sessionCookie(token: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

// ───────── 驗證呼叫者 ─────────
export async function authenticate(req: Request, env: Env): Promise<Actor | null> {
  const authz = req.headers.get("authorization");
  if (authz?.toLowerCase().startsWith("bearer ")) {
    return authenticateToken(env, authz.slice(7).trim());
  }
  const cookie = cookieValue(req, SESSION_COOKIE);
  if (cookie) {
    const hash = await sha256Hex(cookie);
    const row = await env.DB.prepare(
      "SELECT s.user_id, s.expires_at, u.username FROM sessions s JOIN app_users u ON u.id = s.user_id WHERE s.token_hash = ?",
    )
      .bind(hash)
      .first<{ user_id: string; expires_at: string; username: string }>();
    if (row && row.expires_at > nowIso()) {
      return { kind: "session", id: row.user_id, scopes: new Set(ALL_SCOPES), label: row.username };
    }
  }
  return null;
}

export async function authenticateToken(env: Env, raw: string): Promise<Actor | null> {
  if (!raw || raw.length < 20 || raw.length > 200) return null;
  const hash = await sha256Hex(raw);
  const row = await env.DB.prepare("SELECT id, name, scopes, revoked_at FROM api_tokens WHERE token_hash = ?")
    .bind(hash)
    .first<{ id: string; name: string; scopes: string; revoked_at: string | null }>();
  if (!row || row.revoked_at) return null;
  await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
  return { kind: "token", id: row.id, scopes: new Set(row.scopes.split(",").filter(Boolean)), label: row.name };
}

/** 每次 token 呼叫計數，超出每日上限即拒絕（費用控制） */
export async function meterCall(env: Env, actor: Actor, uploadBytes = 0): Promise<void> {
  if (actor.kind === "session") return;
  const day = todayHk();
  const row = await env.DB.prepare(
    `INSERT INTO usage_daily (day, actor, calls, upload_bytes) VALUES (?, ?, 1, ?)
     ON CONFLICT(day, actor) DO UPDATE SET calls = calls + 1, upload_bytes = upload_bytes + excluded.upload_bytes
     RETURNING calls, upload_bytes`,
  )
    .bind(day, actor.id, uploadBytes)
    .first<{ calls: number; upload_bytes: number }>();
  const callLimit = intVar(env.TOKEN_DAILY_CALL_LIMIT, 3000);
  const byteLimit = intVar(env.TOKEN_DAILY_UPLOAD_MB, 800) * 1024 * 1024;
  if (row && (row.calls > callLimit || row.upload_bytes > byteLimit)) {
    throw new HttpError(429, "daily_limit", "今日使用量已達上限，請明天再試或在設定中調整");
  }
}

/** 已登入的 App 請求若會修改資料，必須帶自訂標頭，防止跨站請求偽造 */
export function checkCsrf(req: Request, actor: Actor): void {
  if (actor.kind !== "session") return;
  if (req.method === "GET" || req.method === "HEAD") return;
  if (req.headers.get("x-requested-with") !== "ai-wardrobe") {
    throw new HttpError(403, "csrf", "請求來源驗證失敗");
  }
}

// ───────── 路由 ─────────
export async function handleAuth(req: Request, env: Env, path: string): Promise<Response> {
  if (path === "/api/auth/status" && req.method === "GET") {
    const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_users").first<{ n: number }>();
    const actor = await authenticate(req, env);
    return json({
      setup_required: (users?.n ?? 0) === 0,
      logged_in: actor?.kind === "session",
      username: actor?.kind === "session" ? actor.label : null,
    });
  }

  if (path === "/api/auth/setup" && req.method === "POST") {
    const body = await readJson<{ code?: string; username?: string; password?: string }>(req);
    const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_users").first<{ n: number }>();
    if ((users?.n ?? 0) > 0) throw new HttpError(409, "already_setup", "已完成首次設定，請直接登入");
    const setting = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'setup_code_hash'").first<{ value: string }>();
    if (!setting) throw new HttpError(403, "no_setup_code", "未設定首次設定碼");
    const codeHash = await sha256Hex(String(body.code || "").trim());
    if (!timingSafeEqualStr(codeHash, setting.value)) {
      await bumpLoginFail(env);
      throw new HttpError(403, "bad_code", "設定碼錯誤");
    }
    const username = str(body.username, 40);
    const password = String(body.password || "");
    if (!username) throw new HttpError(400, "bad_username", "請輸入用戶名稱");
    if (password.length < 8) throw new HttpError(400, "weak_password", "密碼最少 8 個字元");
    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
    const id = newId("usr");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO app_users (id, username, password_hash, password_salt, iterations, created_at) VALUES (?,?,?,?,?,?)",
      ).bind(id, username, hash, salt, PBKDF2_ITERATIONS, nowIso()),
      env.DB.prepare("DELETE FROM app_settings WHERE key = 'setup_code_hash'"),
    ]);
    await audit(env, `user:${username}`, "setup");
    return createSession(env, id, req);
  }

  if (path === "/api/auth/login" && req.method === "POST") {
    const fails = await env.DB.prepare("SELECT calls FROM usage_daily WHERE day = ? AND actor = 'login_fail'")
      .bind(todayHk())
      .first<{ calls: number }>();
    if ((fails?.calls ?? 0) >= MAX_LOGIN_FAILS_PER_DAY) {
      throw new HttpError(429, "locked", "登入失敗次數過多，今日暫停登入");
    }
    const body = await readJson<{ username?: string; password?: string }>(req);
    const user = await env.DB.prepare("SELECT * FROM app_users WHERE username = ?")
      .bind(String(body.username || "").trim())
      .first<{ id: string; password_hash: string; password_salt: string; iterations: number }>();
    const ok = user && timingSafeEqualStr(await pbkdf2(String(body.password || ""), user.password_salt, user.iterations), user.password_hash);
    if (!ok) {
      await bumpLoginFail(env);
      throw new HttpError(401, "bad_login", "用戶名稱或密碼錯誤");
    }
    return createSession(env, user!.id, req);
  }

  if (path === "/api/auth/logout" && req.method === "POST") {
    const cookie = cookieValue(req, SESSION_COOKIE);
    if (cookie) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(cookie)).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  throw new HttpError(404, "not_found", "找不到此路徑");
}

async function bumpLoginFail(env: Env) {
  await env.DB.prepare(
    `INSERT INTO usage_daily (day, actor, calls) VALUES (?, 'login_fail', 1)
     ON CONFLICT(day, actor) DO UPDATE SET calls = calls + 1`,
  )
    .bind(todayHk())
    .run();
}

async function createSession(env: Env, userId: string, req: Request): Promise<Response> {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowIso()),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at, user_agent) VALUES (?,?,?,?,?)").bind(
      await sha256Hex(token),
      userId,
      expires,
      nowIso(),
      (req.headers.get("user-agent") || "").slice(0, 200),
    ),
  ]);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) });
}

// ───────── 權杖管理（只限 App 登入使用者） ─────────
export async function handleTokens(req: Request, env: Env, actor: Actor, path: string): Promise<Response> {
  requireSession(actor);
  if (path === "/api/tokens" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, name, token_hint, scopes, created_at, last_used_at, revoked_at FROM api_tokens ORDER BY created_at DESC",
    ).all();
    return json({ tokens: results });
  }
  if (path === "/api/tokens" && req.method === "POST") {
    const body = await readJson<{ name?: string; scopes?: string[] }>(req);
    const name = str(body.name, 60) || "AI 匯入";
    const scopes = (body.scopes?.length ? body.scopes : [...ALL_SCOPES]).filter((s) =>
      (ALL_SCOPES as readonly string[]).includes(s),
    );
    const raw = `aw_${randomToken(32)}`;
    const id = newId("tok");
    await env.DB.prepare(
      "INSERT INTO api_tokens (id, name, token_hash, token_hint, scopes, created_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(id, name, await sha256Hex(raw), raw.slice(-4), scopes.join(","), nowIso())
      .run();
    await audit(env, actor, "token.create", id, { name, scopes });
    // 原始權杖只會在此回傳一次
    return json({ id, name, scopes, token: raw });
  }
  const m = path.match(/^\/api\/tokens\/([\w-]+)$/);
  if (m && req.method === "DELETE") {
    await env.DB.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(nowIso(), m[1]).run();
    await audit(env, actor, "token.revoke", m[1]);
    return json({ ok: true });
  }
  throw new HttpError(404, "not_found", "找不到此路徑");
}
