// Phase 3.8B：增量同步 API、R2 操作統計、R2 用量 API（官方數據成功／權限不足／暫時失敗／未設定）、本機篩選。
// 執行：node test/phase38b.mjs   （本機模擬 D1／R2，不接觸正式服務）
import { makeEnv } from "./harness.mjs";
import { buildWorker, buildModule } from "./doll-build.mjs";
import { addGarment, checker, hex, now } from "./p38-setup.mjs";

const { check, done } = checker();
const worker = await buildWorker("p38b-worker");
const L = await buildModule("src/localWardrobe.ts", "p38b-local");
const env = makeEnv();
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-P38B-1234")), now()).run();
const auth = await worker.fetch(new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-P38B-1234", username: "tester", password: "test-password-1234" }) }), env);
const cookie = auth.headers.get("set-cookie").split(";")[0];
const call = async (method, path, body, e = env) => { const r = await worker.fetch(new Request("http://localhost" + path, { method, headers: { cookie, "x-requested-with": "ai-wardrobe", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), e); return { status: r.status, body: await r.json().catch(() => null) }; };
const SVG = '<rect x="200" y="200" width="500" height="800" fill="#7a3b5e"/>';
for (let i = 0; i < 5; i++) await addGarment(env, { id: `gar_s${"abcde"[i]}`, name: `同步衣物 ${i + 1}`, category: "連身裙", subcategory: "JSK", svg: SVG, price: i % 2 ? 300 : null });

try {
  console.log("增量同步 API");
  let m = (await call("GET", "/api/sync/garments/manifest")).body;
  check("同步清單：全部衣物的 id＋指紋（不需要 offset 分頁）", m.items.length === 5 && m.items.every(([id, fp]) => /^gar_s/.test(id) && /^[0-9a-f]{16}$/.test(fp)) && m.digest.endsWith("-5"), m);
  const same = (await call("GET", "/api/sync/garments/manifest?since=" + encodeURIComponent(m.digest))).body;
  check("沒有改動：只回傳 same（不傳送清單）", same.same === true && !same.items);
  const rows = (await call("POST", "/api/sync/garments", { ids: ["gar_sa", "gar_sb", "nope"] })).body;
  check("只讀取指定衣物（不存在的不回傳）", rows.garments.length === 2 && rows.garments.every((g) => g._fp && g.primary_image_id));
  check("每行指紋與清單一致", rows.garments.every((g) => m.items.find(([id]) => id === g.id)[1] === g._fp));
  // 修改一件 → 只有那件的指紋改變
  await call("PATCH", "/api/garments/gar_sc", { is_favorite: true });
  const m2 = (await call("GET", "/api/sync/garments/manifest?since=" + encodeURIComponent(m.digest))).body;
  const changed = m2.items.filter(([id, fp]) => m.items.find(([i]) => i === id)[1] !== fp).map(([id]) => id);
  check("修改收藏：只有該件指紋改變", !m2.same && changed.join() === "gar_sc", changed);
  // 更新圖片（縮圖版本）→ 指紋改變
  await env.DB.prepare("UPDATE garment_thumbnails SET version='v2' WHERE garment_id='gar_sd'").run();
  const m3 = (await call("GET", "/api/sync/garments/manifest")).body;
  check("圖片／縮圖版本更新：指紋改變", m3.items.find(([id]) => id === "gar_sd")[1] !== m2.items.find(([id]) => id === "gar_sd")[1]);
  // 刪除及封存：不在清單內（等同 tombstone）
  await call("DELETE", "/api/garments/gar_se");
  await env.DB.prepare("UPDATE garments SET status='archived' WHERE id='gar_sb'").run();
  const m4 = (await call("GET", "/api/sync/garments/manifest")).body;
  check("刪除及封存的衣物不在同步清單（本機會移除）", m4.items.length === 3 && !m4.items.some(([id]) => id === "gar_se" || id === "gar_sb"));
  check("同步 API 需要登入", (await worker.fetch(new Request("http://localhost/api/sync/garments/manifest"), env)).status === 401);

  console.log("本機篩選與伺服器結果一致");
  const all = (await call("GET", "/api/garments?status=all&limit=200")).body.garments;
  for (const q of ["", "favorite=1", "priced=0", "priced=1", "sort=name", "sort=price_desc", "category=連身裙&sort=oldest", "q=同步衣物 3"]) {
    const server = (await call("GET", "/api/garments?limit=200&" + q)).body.garments.map((g) => g.id).join();
    const local = L.filterLocal(all, new URLSearchParams(q)).map((g) => g.id).join();
    check(`本機篩選「${q || "全部"}」與伺服器相同`, server === local, { server, local });
  }
  check("封存、自訂屬性篩選交回伺服器處理", !L.localQueryable(new URLSearchParams("status=all")) && !L.localQueryable(new URLSearchParams("attr=x:y")) && L.localQueryable(new URLSearchParams("category=x&sort=name")));
  const st = L.deriveStats(all.filter((g) => g.status !== "archived"));
  const sv = (await call("GET", "/api/stats")).body;
  check("本機推導統計與伺服器一致（離線首頁）", st.total === sv.total && st.favorites === sv.favorites && st.priced_count === sv.priced_count && st.total_value === sv.total_value, { st, sv });

  console.log("R2 操作統計（統一包裝）");
  await env.DB.prepare("DELETE FROM r2_usage").run();
  const img = (await env.DB.prepare("SELECT id FROM garment_images WHERE garment_id='gar_sa'").first()).id;
  await worker.fetch(new Request(`http://localhost/api/images/${img}`, { headers: { cookie } }), env);
  await worker.fetch(new Request(`http://localhost/api/images/${img}`, { headers: { cookie } }), env);
  const ops = (await env.DB.prepare("SELECT purpose, op, n, env FROM r2_usage").all()).results;
  const reads = ops.filter((o) => o.op === "class_b").reduce((s, o) => s + o.n, 0);
  check("讀取圖片：真正向 R2 發出的 GetObject 計為 Class B，並記錄用途", reads >= 2 && ops.every((o) => o.op === "class_b" && typeof o.purpose === "string"), ops);
  const R = await buildModule("worker/r2usage.ts", "p38b-r2");
  check("用途按 R2 路徑分類", ["originals/a/x.png", "processed/a/x.png", "outfits/o/x.png", "doll/assets/d/x.png", "doll/models/m/x.png", "settings/home-bg-1.png", "misc/x"].map(R.purposeOf).join() === "originals,processed,outfits,doll_assets,doll_models,home_bg,other");
  check("操作類別：Get／Head＝B、Put／List＝A、Delete＝免費", R.classOf("GetObject") === "class_b" && R.classOf("HeadObject") === "class_b" && R.classOf("PutObject") === "class_a" && R.classOf("ListObjects") === "class_a" && R.classOf("DeleteObject") === "free");
  check("沒有設定環境名稱的測試環境標示為 test（與正式／預覽分開）", ops.every((o) => o.env === "test"));
  await call("GET", "/api/stats");
  const ops2 = (await env.DB.prepare("SELECT SUM(n) AS n FROM r2_usage").first()).n;
  check("沒有 R2 操作的請求不會增加計數", ops2 === ops.reduce((s, o) => s + o.n, 0));
  const env0 = makeEnv({ withoutR2Usage: true });
  Object.assign(env0, { DB: env.DB });
  const envNoTable = makeEnv({ withoutR2Usage: true });
  const r0 = await worker.fetch(new Request("http://localhost/api/health"), envNoTable);
  check("統計資料表未建立：正常功能不受影響", r0.status === 200);

  console.log("R2 用量 API");
  let u = (await call("GET", "/api/r2/usage")).body;
  check("未設定官方 Token：清楚列出缺少的設定，不顯示虛構數字", u.official.available === false && u.official.reason === "missing_config" && u.official.missing.length === 2 && !u.official.account && u.cost === null);
  check("App 自身用量：按用途的物件及容量（由 D1 記錄，不掃描 R2）", u.app.storage.processed.objects === 4 && u.app.storage.processed.bytes > 0 && u.purposes.length === 8, u.app.storage);
  check("沒有官方數據時，免費額度比例標示為 App 估算", u.free_use.source === "app_estimate");
  check("定價：Standard 免費 10 GB-month、Class A 100 萬、Class B 1,000 萬；US$0.015／4.50／0.36", u.pricing.free.gb_month === 10 && u.pricing.free.class_a === 1e6 && u.pricing.free.class_b === 1e7 && u.pricing.price.class_a_per_million === 4.5 && u.pricing.price.class_b_per_million === 0.36);
  check("縮圖補建讀取另外顯示（不當作每月官方額度）", typeof u.app.thumbnail_backfill_reads === "number");
  // 官方數據：模擬 Cloudflare GraphQL
  const realFetch = globalThis.fetch;
  const envOff = { ...env, CF_API_TOKEN: "test-token", CF_ACCOUNT_ID: "acc123" };
  const today = new Date().toISOString().slice(0, 10);
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.cloudflare.com/")) {
      calls++;
      const auth = new Headers(init.headers).get("authorization");
      if (auth !== "Bearer test-token") return new Response("{}", { status: 403 });
      return Response.json({ data: { viewer: { accounts: [{ ops: [
        { sum: { requests: 900000 }, dimensions: { actionType: "GetObject", bucketName: "ai-wardrobe-images" } },
        { sum: { requests: 1200 }, dimensions: { actionType: "PutObject", bucketName: "ai-wardrobe-images" } },
        { sum: { requests: 300 }, dimensions: { actionType: "ListObjects", bucketName: "ai-wardrobe-preview-images" } },
        { sum: { requests: 50 }, dimensions: { actionType: "DeleteObject", bucketName: "ai-wardrobe-images" } },
      ], st: [
        { max: { payloadSize: 2e9, metadataSize: 0, objectCount: 800 }, dimensions: { date: today, bucketName: "ai-wardrobe-images" } },
        { max: { payloadSize: 1e8, metadataSize: 0, objectCount: 20 }, dimensions: { date: today, bucketName: "ai-wardrobe-preview-images" } },
      ] }] } } });
    }
    return realFetch(url, init);
  };
  u = (await call("GET", "/api/r2/usage", null, envOff)).body;
  check("官方數據成功取得：Class A／B 按官方分類（DeleteObject 免費）", u.official.available && u.official.account.class_a === 1500 && u.official.account.class_b === 900000 && u.official.account.free === 50, u.official.account);
  check("目前容量與本月 GB-month 分開（GB-month 由每日容量估算）", u.official.account.storage_bytes === 2.1e9 && u.official.account.gb_month_est > 0 && u.official.account.gb_month_est < 2.1);
  check("正式與預覽 Bucket 分開顯示", u.official.buckets["ai-wardrobe-images"].class_b === 900000 && u.official.buckets["ai-wardrobe-preview-images"].class_a === 300);
  check("免費額度內：預計費用 US$0", u.cost.total === 0 && u.free_use.source === "official");
  check("Class B 已用 9% → 未達 70% 警告門檻", Math.round(u.free_use.class_b * 100) === 9);
  const c1 = calls;
  await call("GET", "/api/r2/usage", null, envOff);
  check("結果快取 10 分鐘：再次開啟用量頁不會重複呼叫 Cloudflare API", calls === c1);
  await call("GET", "/api/r2/usage?refresh=1", null, envOff);
  check("按重新整理才重新取得", calls === c1 + 1);
  // 接近免費額度：軟上限保護
  globalThis.fetch = async (url, init) => String(url).startsWith("https://api.cloudflare.com/") ? Response.json({ data: { viewer: { accounts: [{ ops: [{ sum: { requests: 9_500_000 }, dimensions: { actionType: "GetObject", bucketName: "ai-wardrobe-images" } }], st: [] }] } } }) : realFetch(url, init);
  u = (await call("GET", "/api/r2/usage?refresh=1", null, envOff)).body;
  check("用量 95%：超過軟上限 90%，暫停非必要背景工作", u.background.allowed === false && /軟上限/.test(u.background.reason));
  const claim = (await call("POST", "/api/thumbnails/jobs/claim", {}, envOff)).body;
  check("縮圖補建（非必要）被暫停", claim.job === null && /軟上限/.test(claim.paused));
  check("正常查看圖片不受影響", (await worker.fetch(new Request(`http://localhost/api/images/${img}`, { headers: { cookie } }), envOff)).status === 200);
  await call("PUT", "/api/r2/alerts", { warn: [60, 80], soft_limit: 99 }, envOff);
  u = (await call("GET", "/api/r2/usage", null, envOff)).body;
  check("可設定警告比例及軟上限", u.alerts.warn.join() === "60,80" && u.alerts.soft_limit === 99 && u.background.allowed === true);
  // 權限不足、暫時失敗
  globalThis.fetch = async (url, init) => String(url).startsWith("https://api.cloudflare.com/") ? new Response("{}", { status: 403 }) : realFetch(url, init);
  u = (await call("GET", "/api/r2/usage?refresh=1", null, envOff)).body;
  check("官方 API 權限不足：清楚說明需要的權限", u.official.available === false && u.official.reason === "permission" && /Account Analytics/.test(u.official.message));
  globalThis.fetch = async (url, init) => String(url).startsWith("https://api.cloudflare.com/") ? new Response("busy", { status: 503 }) : realFetch(url, init);
  u = (await call("GET", "/api/r2/usage?refresh=1", null, envOff)).body;
  check("官方 API 暫時失敗：如實回報，沒有虛構數字", u.official.available === false && u.official.reason === "api_error" && u.cost === null);
  globalThis.fetch = realFetch;
  check("R2 用量 API 需要登入（Token 不會給 AI 連接器）", (await worker.fetch(new Request("http://localhost/api/r2/usage"), envOff)).status === 401);
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
} finally {
  done();
}
