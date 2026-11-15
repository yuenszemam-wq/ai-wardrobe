// Phase 3.8C：離線同步的伺服器部分（角色造型版本基準及原子回滾、衣物版本衝突、上傳及建立的冪等）＋ local: ID 換算。
// 執行：node test/phase38c.mjs   （本機模擬 D1／R2）
import { makeEnv } from "./harness.mjs";
import { buildWorker, buildModule } from "./doll-build.mjs";
import { addGarment, checker, hex, now } from "./p38-setup.mjs";

const { check, done } = checker();
const worker = await buildWorker("p38c-worker");
const env = makeEnv();
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-P38C-1234")), now()).run();
const auth = await worker.fetch(new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-P38C-1234", username: "tester", password: "test-password-1234" }) }), env);
const cookie = auth.headers.get("set-cookie").split(";")[0];
const call = async (method, path, body) => { const r = await worker.fetch(new Request("http://localhost" + path, { method, headers: { cookie, "x-requested-with": "ai-wardrobe", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env); return { status: r.status, body: await r.json().catch(() => null) }; };
try {
  console.log("local: ID 換算（純函數）");
  globalThis.window = { dispatchEvent() {}, addEventListener() {} };
  globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };
  const O = await buildModule("src/outbox.ts", "p38c-outbox").catch((e) => ({ err: e }));
  if (O.resolveLocal) {
    const all = { op_a: { asset: "sta_real", version: "stv_real" } };
    const p = O.resolveLocal({ layers: [{ asset_id: "local:op_a:asset", asset_version_id: "local:op_a:version", name: "local 不是 ID" }] }, all);
    check("local:<op>:<欄位> 換成伺服器 ID；其他字串不變", p.layers[0].asset_id === "sta_real" && p.layers[0].asset_version_id === "stv_real" && p.layers[0].name === "local 不是 ID", p);
    check("依賴未完成＝null（不會送出未換算的 ID）", O.resolveLocal({ a: "local:op_b:asset" }, all) === null);
    check("找出場景內的依賴", O.localDeps({ x: ["local:op_a:asset", "local:op_c:version", "local:op_a:version"] }).join() === "op_a,op_c");
  } else check("載入 outbox 模組", false, String(O.err));

  console.log("角色造型版本基準");
  await addGarment(env, { id: "gar_a", name: "A", category: "上衣", subcategory: "上衣", svg: '<rect x="1" y="1" width="5" height="5" fill="#000"/>' });
  let r = await call("POST", "/api/doll/looks", { name: "原本", state: { items: [{ garment_id: "gar_a", slot: "top" }] } });
  const look = r.body;
  r = await call("PATCH", `/api/doll/looks/${look.id}`, { name: "改名", base_updated_at: look.updated_at });
  check("版本相同：保存成功", r.status === 200 && r.body.name === "改名", r.body);
  const v2 = r.body.updated_at;
  r = await call("PATCH", `/api/doll/looks/${look.id}`, { name: "舊版本", state: { items: [] }, base_updated_at: look.updated_at });
  const after = (await call("GET", `/api/doll/looks/${look.id}`)).body;
  check("版本不同：409，名稱及衣物索引都不變（整個交易回滾）", r.status === 409 && r.body.error.code === "look_conflict" && after.name === "改名" && (await env.DB.prepare("SELECT COUNT(*) AS n FROM doll_look_items WHERE look_id = ?").bind(look.id).first()).n === 1, [r.status, after.name]);
  const realBatch = env.DB.batch.bind(env.DB); let raced = false;
  env.DB.batch = async (stmts) => { if (!raced) { raced = true; env.DB.sqlite.exec(`UPDATE doll_looks SET updated_at = '2031-01-01T00:00:00.000Z' WHERE id = '${look.id}'`); } return realBatch(stmts); };
  r = await call("PATCH", `/api/doll/looks/${look.id}`, { name: "競態", state: { items: [] }, base_updated_at: v2 });
  env.DB.batch = realBatch;
  check("檢查後才被另一處保存（競態）：409 並回滾", r.status === 409 && (await call("GET", `/api/doll/looks/${look.id}`)).body.name === "改名" && (await env.DB.prepare("SELECT COUNT(*) AS n FROM doll_look_items WHERE look_id = ?").bind(look.id).first()).n === 1);
  r = await call("PATCH", `/api/doll/looks/${look.id}`, { name: "覆寫" });
  check("沒有版本基準（使用者選擇覆寫）：保存", r.status === 200 && r.body.name === "覆寫");

  console.log("衣物版本及冪等");
  const g = (await call("GET", "/api/garments/gar_a")).body;
  r = await call("PATCH", "/api/garments/gar_a", { is_favorite: true, expected_version: g.version });
  check("離線修改帶原本版本號：版本相同可保存", r.status === 200);
  r = await call("PATCH", "/api/garments/gar_a", { name: "舊", expected_version: g.version });
  check("版本已改變：409 version_conflict", r.status === 409 && r.body.error.code === "version_conflict");
  const c1 = await call("POST", "/api/garments", { name: "離線新增", client_key: "op_offline_create_1" });
  const c2 = await call("POST", "/api/garments", { name: "離線新增", client_key: "op_offline_create_1" });
  check("同一 client_key 重送建立衣物：同一件", c1.body.id === c2.body.id && (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments WHERE name = '離線新增'").first()).n === 1);
} catch (e) { console.error(e); check("未預期錯誤", false, String(e)); }
done();
