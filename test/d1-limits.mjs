// 回歸測試：正式 D1 每個查詢最多 100 個綁定參數。衣物超過 100 件時，同步及 AI 狀態批次更新不可出現 500。
// 執行：node test/d1-limits.mjs   （本機模擬 D1／R2，不接觸正式服務；模擬 D1 同樣限制 100 個參數）
import { makeEnv } from "./harness.mjs";
import { buildWorker } from "./doll-build.mjs";
import { checker, hex, now } from "./p38-setup.mjs";

const { check, done } = checker();
const worker = await buildWorker("d1-limits-worker");
const env = makeEnv();
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-D1L-1234")), now()).run();
const auth = await worker.fetch(new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-D1L-1234", username: "owner", password: "password-1234" }) }), env);
const cookie = auth.headers.get("set-cookie").split(";")[0];
const call = async (method, path, body) => { const r = await worker.fetch(new Request("http://localhost" + path, { method, headers: { cookie, "x-requested-with": "ai-wardrobe", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), env); return { status: r.status, body: await r.json().catch(() => null) }; };

const N = 150;
const ids = Array.from({ length: N }, (_, i) => `gar_lim${String(i).padStart(3, "0")}`);
for (const id of ids) await env.DB.prepare("INSERT INTO garments (id, name, category, status, ai_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").bind(id, "衣物 " + id, "連身裙", "active", "pending_ai", now(), now()).run();

try {
  let threw = false;
  try { await env.DB.prepare(`SELECT 1 FROM garments WHERE id IN (${ids.slice(0, 101).map(() => "?").join(",")})`).bind(...ids.slice(0, 101)).all(); } catch { threw = true; }
  check("模擬 D1：超過 100 個參數會報錯（與正式 D1 相同）", threw);
  const m = await call("GET", "/api/sync/garments/manifest");
  check("同步清單：150 件", m.status === 200 && m.body.items.length === N, m.status);
  const rows = await call("POST", "/api/sync/garments", { ids });
  check("一次讀取 150 件不會 500（伺服器分批查詢）", rows.status === 200 && rows.body.garments.length === N, rows.status, rows.body?.error);
  const big = await call("POST", "/api/sync/garments", { ids: [...ids, ...ids] });
  check("最多 200 件，重複的 ID 照常處理", big.status === 200 && big.body.garments.length >= N, big.status);
  const st = await call("POST", "/api/ai/status", { garment_ids: ids, ai_status: "done" });
  check("AI 狀態批次更新 150 件不會 500", st.status === 200 && st.body.updated === N, st.status, st.body);
  const left = (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments WHERE ai_status = 'done'").first()).n;
  check("150 件全部更新", left === N, left);
} finally {
  done();
}
