// Phase 3.9B.1：衣櫃分享 API（建立、權杖只存雜湊、公開投影白名單、選擇／全部排除、封存不公開、圖片限制、
// 公開分析只計公開集合、撤銷、到期、重新產生、限流、需要登入的管理端點、未套用 0016 時的回應）。
// 執行：node test/phase39b1.mjs   （本機模擬 D1／R2）
import { makeEnv } from "./harness.mjs";
import { buildWorker } from "./doll-build.mjs";
import { addGarment, checker, hex, now } from "./p38-setup.mjs";

const { check, done } = checker();
const worker = await buildWorker("p39b1-worker");
const env = makeEnv();
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-P39B1-1234")), now()).run();
const auth = await worker.fetch(new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-P39B1-1234", username: "tester", password: "test-password-1234" }) }), env);
const cookie = auth.headers.get("set-cookie").split(";")[0];
const call = async (method, path, body, withCookie = true) => { const r = await worker.fetch(new Request("http://localhost" + path, { method, headers: { ...(withCookie ? { cookie } : {}), "x-requested-with": "ai-wardrobe", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env); const ct = r.headers.get("content-type") || ""; return { status: r.status, body: ct.includes("json") ? await r.json().catch(() => null) : null, raw: r }; };
const pub = (path) => call("GET", path, undefined, false);
const SVG = '<rect x="200" y="200" width="500" height="800" fill="#7a3b5e"/>';
try {
  for (const [id, name, cat, price] of [["gar_a", "紫色 JSK", "連身裙", 1200], ["gar_b", "白色上衣", "上衣", 300], ["gar_c", "黑色裙", "半身裙", 500], ["gar_d", "封存衣物", "上衣", 99]]) await addGarment(env, { id, name, category: cat, subcategory: cat, svg: SVG, price });
  await env.DB.prepare("UPDATE garments SET brand = 'AP', notes = '私人備註：在旺角買', primary_color = '紫色' WHERE id = 'gar_a'").run();
  await env.DB.prepare("UPDATE garments SET status = 'archived' WHERE id = 'gar_d'").run();
  // 原始相片（不應公開）
  await env.IMAGES.put("garments/gar_b/orig.jpg", new Uint8Array([1, 2, 3]));
  await env.DB.prepare("INSERT INTO garment_images (id,garment_id,image_type,r2_key,mime_type,width,height,file_size,sha256,has_alpha,is_primary,created_at) VALUES ('img_origb','gar_b','original','garments/gar_b/orig.jpg','image/jpeg',10,10,3,'x',0,0,?)").bind(now()).run();

  console.log("建立及權杖");
  let r = await call("POST", "/api/shares", { title: "朋友看", scope: "selected", garment_ids: ["gar_a", "gar_b", "gar_d", "gar_nope"] });
  check("建立連結：只回傳一次完整連結", r.status === 201 && /\/s\/[A-Za-z0-9_-]{20,}$/.test(r.body.url) && r.body.item_count === 3, r.body);
  const token = r.body.token, sid = r.body.id;
  const row = await env.DB.prepare("SELECT token_hash FROM share_links WHERE id = ?").bind(sid).first();
  check("伺服器只保存權杖的 SHA-256", row.token_hash === (await hex(new TextEncoder().encode(token))) && row.token_hash !== token);
  check("列表不包含權杖", !JSON.stringify((await call("GET", "/api/shares")).body).includes(token));

  console.log("公開投影");
  r = await pub(`/api/share/${token}`);
  check("不需登入即可瀏覽", r.status === 200 && r.body.title === "朋友看");
  check("只公開選擇的衣物；封存衣物永不公開", r.body.garments.map((g) => g.id).sort().join() === "gar_a,gar_b", r.body.garments.map((g) => g.id));
  const ga = r.body.garments.find((g) => g.id === "gar_a");
  check("預設欄位：名稱、分類、品牌、顏色；不包括價格及備註", ga.name === "紫色 JSK" && ga.brand === "AP" && ga.colors[0] === "紫色" && !("price" in ga) && !("notes" in ga), ga);
  check("回應不包含私人資料（備註、原始相片 ID、R2 key）", !JSON.stringify(r.body).includes("私人備註") && !JSON.stringify(r.body).includes("img_origb") && !JSON.stringify(r.body).includes("garments/"));
  check("公開回應 no-store 及 noindex", r.raw.headers.get("cache-control") === "no-store" && /noindex/.test(r.raw.headers.get("x-robots-tag") || ""));
  check("預設不公開分析", r.body.analytics === null);

  console.log("公開圖片");
  r = await pub(`/api/share/${token}/thumb/gar_a`);
  check("縮圖（重新編碼 WebP）", r.status === 200 && r.raw.headers.get("content-type") === "image/webp" && /private/.test(r.raw.headers.get("cache-control")));
  r = await pub(`/api/share/${token}/image/gar_a`);
  check("去背透明圖（公開該欄位時）", r.status === 200 && r.raw.headers.get("content-type") === "image/png");
  r = await pub(`/api/share/${token}/thumb/gar_c`);
  check("沒有公開的衣物：圖片 404", r.status === 404);
  r = await pub(`/api/share/${token}/thumb/gar_d`);
  check("封存衣物圖片 404", r.status === 404);

  console.log("欄位及分析");
  r = await call("PATCH", `/api/shares/${sid}`, { fields: ["name", "category", "price"], options: { analytics: true } });
  r = await pub(`/api/share/${token}`);
  const g2 = r.body.garments.find((g) => g.id === "gar_a");
  check("改為只公開名稱、分類及價格", g2.price === 1200 && !("brand" in g2) && !("colors" in g2), g2);
  check("公開分析只計算公開集合（總值 1500，不含未公開及封存衣物）", r.body.analytics.total === 2 && r.body.analytics.price.total === 1500 && !r.body.analytics.by_brand, r.body.analytics);
  r = await pub(`/api/share/${token}/image/gar_a`);
  check("沒有公開「去背高清圖」：高清圖 404，縮圖仍可", r.status === 404 && (await pub(`/api/share/${token}/thumb/gar_a`)).status === 200);

  console.log("全部（排除）");
  r = await call("PATCH", `/api/shares/${sid}`, { scope: "all", garment_ids: ["gar_b"] });
  r = await pub(`/api/share/${token}`);
  check("公開全部再排除：排除的衣物及封存衣物不公開", r.body.garments.map((g) => g.id).sort().join() === "gar_a,gar_c", r.body.garments.map((g) => g.id));

  console.log("撤銷、重新產生、到期");
  r = await call("POST", `/api/shares/${sid}/rotate`);
  const token2 = r.body.token;
  check("重新產生：舊連結即時失效，新連結可用", (await pub(`/api/share/${token}`)).status === 404 && (await pub(`/api/share/${token2}`)).status === 200);
  await call("POST", `/api/shares/${sid}/revoke`);
  r = await pub(`/api/share/${token2}`);
  check("撤銷：連結 404，訊息不透露細節", r.status === 404 && r.body.error.code === "share_not_found");
  check("撤銷後圖片亦不可讀", (await pub(`/api/share/${token2}/thumb/gar_a`)).status === 404);
  r = await call("POST", "/api/shares", { title: "短期", scope: "selected", garment_ids: ["gar_a"], expires_at: new Date(Date.now() + 86400_000).toISOString() });
  const t3 = r.body.token;
  await env.DB.prepare("UPDATE share_links SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), r.body.id).run();
  check("到期後連結失效", (await pub(`/api/share/${t3}`)).status === 404);
  r = await call("POST", "/api/shares", { title: "過去", scope: "selected", garment_ids: ["gar_a"], expires_at: "2020-01-01" });
  check("不能設定已過的到期日", r.status === 400);
  r = await call("POST", "/api/shares", { title: "空", scope: "selected", garment_ids: [] });
  check("只公開選擇的衣物時必須選擇衣物", r.status === 400 && r.body.error.code === "no_items");

  console.log("限流及權限");
  r = await call("POST", "/api/shares", { title: "限流", scope: "selected", garment_ids: ["gar_a"] });
  const t4 = r.body.token;
  let last = 200;
  for (let i = 0; i < 125; i++) last = (await pub(`/api/share/${t4}`)).status;
  check("每條連結每分鐘最多 120 次讀取", last === 429, last);
  check("管理端點需要登入", (await pub("/api/shares")).status === 401);
  check("亂碼權杖：404", (await pub("/api/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).status === 404);
  r = await call("DELETE", `/api/shares/${sid}`);
  check("刪除連結設定", r.status === 200 && !(await env.DB.prepare("SELECT id FROM share_links WHERE id = ?").bind(sid).first()) && !(await env.DB.prepare("SELECT 1 FROM share_link_items WHERE share_id = ?").bind(sid).first()));

  console.log("未套用 0016");
  const env2 = makeEnv({ withoutShare: true });
  const r2 = await worker.fetch(new Request("http://localhost/api/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), env2);
  check("公開端點：404（不會 500）", r2.status === 404);
} catch (e) { console.error(e); check("未預期錯誤", false, String(e)); }
done();
