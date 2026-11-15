// Phase 3.9A.3：完整創作工作室 API（角色換裝素材圖層及骨骼附接、背景預設庫、引用及清理）＋素材圖層純函數。
// 執行：node test/phase39a3.mjs   （本機模擬 D1／R2）
import { makeEnv } from "./harness.mjs";
import { buildWorker, buildModule } from "./doll-build.mjs";
import { checker, hex, now, sharp } from "./p38-setup.mjs";

const { check, done } = checker();
const worker = await buildWorker("p393-worker");
const P = await buildModule("shared/lookProps.ts", "p393-props");
const env = makeEnv();
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-P393-1234")), now()).run();
const auth = await worker.fetch(new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-P393-1234", username: "tester", password: "test-password-1234" }) }), env);
const cookie = auth.headers.get("set-cookie").split(";")[0];
const call = async (method, path, body) => { const r = await worker.fetch(new Request("http://localhost" + path, { method, headers: { cookie, "x-requested-with": "ai-wardrobe", ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined }), env); const ct = r.headers.get("content-type") || ""; return { status: r.status, body: ct.includes("json") ? await r.json().catch(() => null) : null }; };
const png = () => sharp({ create: { width: 100, height: 160, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: Buffer.from('<svg width="100" height="160"><rect x="20" y="20" width="60" height="120" fill="#c48"/></svg>') }]).png().toBuffer();
const upload = async (extra = {}) => { const f = new FormData(); f.set("file", new Blob([await png()], { type: "image/png" }), "a.png"); f.set("kind", extra.kind || "prop"); f.set("name", extra.name || "道具"); if (extra.lib) f.set("in_library", "1"); return (await call("POST", "/api/studio/assets", f)).body; };
const prop = (a, extra = {}) => ({ layer_id: "pr_" + Math.random().toString(36).slice(2, 8), asset_id: a.id, version_id: a.version.id, name: a.name, bone: "wrist_r", z: "front", cx: 10, cy: 20, w: 120, h: 190, ...extra });

try {
  console.log("素材圖層純函數");
  const n = P.normalizeProp({ layer_id: "pr_a", asset_id: "sta_x", version_id: "stv_x", bone: "evil", z: "weird", cx: 1e9, rotation: 725, opacity: 3 });
  check("不認識的骨骼＝固定畫面；不認識的前後＝最前；數值限制範圍；角度正規化", n.bone === "world" && n.z === "front" && n.cx === 3600 && n.rotation === 5 && n.opacity === 1, n);
  check("缺少素材版本的圖層被略過", P.normalizeProp({ layer_id: "pr_b", asset_id: "sta_x" }) === null);
  check("最多 30 個圖層、圖層識別不重複", P.normalizeProps([...Array(40)].map((_, i) => ({ layer_id: "pr_" + (i % 35), asset_id: "sta_x", version_id: "stv_x" }))).length === 30);
  check("圖片網址（原圖／去背圖）", P.propSrc({ version_id: "stv_a", variant: "cutout" }) === "/api/studio/versions/stv_a?cutout=1");

  console.log("角色造型的素材圖層");
  const own = await upload({ name: "只此造型" });
  const lib = await upload({ name: "素材庫道具", lib: true });
  let r = await call("POST", "/api/doll/looks", { name: "有道具", state: { items: [], props: [prop(own), prop(lib, { bone: "head", z: "back" })] } });
  check("保存素材圖層（附接骨骼、前後）", r.status === 201 && r.body.state.props.length === 2 && r.body.state.props[1].bone === "head" && r.body.state.props[1].z === "back", r.body?.state?.props ?? r.body);
  const lookId = r.body.id;
  r = await call("POST", "/api/doll/looks", { name: "壞道具", state: { items: [], props: [{ ...prop(own), version_id: "stv_nope" }] } });
  check("引用不存在的素材版本被拒絕", r.status === 400 && r.body.error.code === "asset_not_found");
  r = await call("POST", "/api/doll/looks", { name: "壞去背", state: { items: [], props: [prop(own, { variant: "cutout" })] } });
  check("未有去背圖時不可使用去背圖", r.status === 400 && r.body.error.code === "no_cutout");
  const list = (await call("GET", "/api/studio/assets?library=0")).body.assets;
  check("素材使用次數包括角色造型的素材圖層", list.find((a) => a.id === own.id).used_by === 1 && list.find((a) => a.id === lib.id).used_by === 1, list.map((a) => [a.name, a.used_by]));
  r = await call("DELETE", `/api/studio/assets/${lib.id}`);
  check("被角色造型使用的素材：只移出素材庫，不刪除檔案", r.body.deleted === false && r.body.used_by.some((u) => u.kind === "look"));
  await call("PATCH", `/api/studio/assets/${lib.id}`, { in_library: true });
  const ownKey = (await env.DB.prepare("SELECT r2_key FROM studio_asset_versions WHERE asset_id = ?").bind(own.id).first()).r2_key;
  r = await call("DELETE", `/api/doll/looks/${lookId}`);
  check("刪除角色造型：只用於該造型的素材一併清理；素材庫內的保留", r.status === 200 && !(await env.DB.prepare("SELECT id FROM studio_assets WHERE id = ?").bind(own.id).first()) && !env.IMAGES.objects.has(ownKey) && !!(await env.DB.prepare("SELECT id FROM studio_assets WHERE id = ?").bind(lib.id).first()), r.body);

  console.log("背景預設庫");
  r = await call("GET", "/api/studio/bg-presets");
  check("初始沒有預設", r.status === 200 && r.body.presets.length === 0);
  r = await call("POST", "/api/studio/bg-presets", { name: "粉紅條紋", spec: { type: "stripes", color: "#fde8ef", color2: "#f6c9d8", size: 20, gap: 20, angle: 90 } });
  check("保存條紋背景為預設（完整設定）", r.status === 201 && r.body.presets[0].name === "粉紅條紋" && r.body.presets[0].spec.type === "stripes" && r.body.presets[0].spec.size === 20, r.body);
  const bgAsset = await upload({ kind: "background", name: "花園" });
  r = await call("POST", "/api/studio/bg-presets", { name: "花園", spec: { type: "image", image: { asset_id: bgAsset.id, version_id: bgAsset.version.id, fit: "cover" } } });
  check("保存圖片背景為預設：素材自動保留在我的背景", r.status === 201 && r.body.presets.length === 2 && (await env.DB.prepare("SELECT in_library FROM studio_assets WHERE id = ?").bind(bgAsset.id).first()).in_library === 1);
  const pid = r.body.presets[0].id;
  r = await call("DELETE", `/api/studio/assets/${bgAsset.id}`);
  check("被背景預設使用的素材不會被刪除", r.body.deleted === false && r.body.used_by.some((u) => u.kind === "preset"), r.body);
  r = await call("POST", "/api/studio/bg-presets", { name: "壞", spec: { type: "image", image: { asset_id: "sta_nope", version_id: "stv_nope" } } });
  check("引用不存在的背景圖片被拒絕", r.status === 400);
  r = await call("POST", "/api/studio/bg-presets", { name: "壞", spec: { type: "evil" } });
  check("不正確的背景設定被拒絕", r.status === 400);
  r = await call("DELETE", `/api/studio/bg-presets/${pid}`);
  check("刪除預設", r.status === 200 && r.body.presets.length === 1 && r.body.presets[0].name === "粉紅條紋");
  r = await call("DELETE", `/api/studio/bg-presets/bgp_nopeabcd`);
  check("刪除不存在的預設：404", r.status === 404);
  for (let i = 0; i < 39; i++) await call("POST", "/api/studio/bg-presets", { name: "p" + i, spec: { type: "solid", color: "#000000" } });
  r = await call("POST", "/api/studio/bg-presets", { name: "太多", spec: { type: "solid", color: "#000000" } });
  check("最多 40 個預設（明確錯誤）", r.status === 400 && r.body.error.code === "too_many_presets");
  const unauth = await worker.fetch(new Request("http://localhost/api/studio/bg-presets"), env);
  check("需要登入", unauth.status === 401);
} catch (e) {
  console.error(e);
  check("未預期錯誤", false, String(e));
}
done();
