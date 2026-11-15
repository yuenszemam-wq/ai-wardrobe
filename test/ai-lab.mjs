// AI Lab Phase 1（Workers AI 衣物辨認）API 測試：以 Mock env.AI 模擬模型（不呼叫真正 Workers AI、不產生費用）。
// 執行：node test/ai-lab.mjs（需要 esbuild、sharp）
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { makeEnv } from "./harness.mjs";

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_PATH || "sharp");
mkdirSync(new URL("./.tmp/", import.meta.url), { recursive: true });
const outfile = new URL("./.tmp/worker-ailab.mjs", import.meta.url).pathname;
await build({ target: "es2022", loader: { ".wasm": "binary" }, entryPoints: [new URL("../worker/index.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", outfile, logLevel: "error" });
const worker = (await import(outfile + "?t=" + Date.now())).default;
const { validateAiOutput, extractJson, cleanText } = await import("../worker/aiLab/validate.ts");

const origLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && a[0].startsWith('{"m"')) return; origLog(...a); };
let passed = 0; const failures = [];
const check = (name, cond, info) => { if (cond) { passed++; console.log("  ✓", name); } else { failures.push(name); console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 400) : ""); } };
const hex = async (u8) => Buffer.from(await crypto.subtle.digest("SHA-256", u8)).toString("hex");

// ── Mock Workers AI ──
let aiCalls = 0, nextReply = null, aiDelay = 0, lastInput = null;
const mockAI = { async run(model, input) {
  aiCalls++; lastInput = { model, input };
  if (aiDelay) await new Promise((r) => setTimeout(r, aiDelay));
  const r = typeof nextReply === "function" ? nextReply(input) : nextReply;
  if (r instanceof Error) throw r;
  return r;
} };
const env = { ...makeEnv(), AI: mockAI, AW_ENV: "preview", AI_LAB_ENABLED: "true", AI_PROVIDER: "workers-ai", AI_MODEL: "@cf/meta/llama-3.2-11b-vision-instruct", AI_DAILY_REQUEST_LIMIT: "50", AI_MONTHLY_REQUEST_LIMIT: "500", AI_MAX_BATCH_SIZE: "10", AI_MAX_CONCURRENCY: "1", AI_DAILY_NEURON_BUDGET: "5000", AI_PAID_USAGE_ENABLED: "false" };
const ORIGIN = "https://ai-wardrobe.example.workers.dev";
let cookie = "";
async function call(method, path, { body, form, noAuth } = {}) {
  const h = new Headers();
  if (cookie && !noAuth) { h.set("cookie", cookie); if (method !== "GET") h.set("x-requested-with", "ai-wardrobe"); }
  let payload;
  if (body !== undefined) { h.set("content-type", "application/json"); payload = JSON.stringify(body); }
  if (form) payload = form;
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: payload }), env);
  const sc = res.headers.get("set-cookie");
  if (sc && sc.startsWith("aw_session=") && !sc.includes("Max-Age=0")) cookie = sc.split(";")[0];
  const t = await res.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: res.status, body: j };
}

await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('setup_code_hash', ?, ?)").bind(await hex(new TextEncoder().encode("SETUP-AILAB-1")), new Date().toISOString()).run();
await call("POST", "/api/auth/setup", { body: { code: "SETUP-AILAB-1", username: "sally", password: "password123" } });
const tax = (await call("GET", "/api/taxonomy")).body;
const catOf = (name) => tax.categories.find((c) => c.name === name);
const attr = (id) => tax.attributes.find((a) => a.id === id);
const opt = (aid, name) => attr(aid)?.options.find((o) => o.name === name)?.id;
const dress = catOf("連身裙"), skirt = catOf("半身裙");
const jskId = dress?.subs.find((s) => s.name === "JSK")?.id;

// 測試衣物及圖片
const png = new Uint8Array(await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#2a1f33" } }).png().toBuffer());
const small = new Uint8Array(await sharp(Buffer.from(png)).resize(768, 1024).jpeg({ quality: 85 }).toBuffer());
async function mkGarment(name, category = null) {
  const g = (await call("POST", "/api/garments", { body: { name, category, needs_review: true } })).body;
  const fd = new FormData(); fd.set("garment_id", g.id); fd.set("image_type", "original"); fd.set("file", new Blob([png], { type: "image/png" }), "a.png");
  const img = (await call("POST", "/api/images/upload", { form: fd })).body;
  const fresh = (await call("GET", `/api/garments/${g.id}`)).body;
  return { id: g.id, image: img.id, version: fresh.version };
}
let rid = 0;
const newRid = () => `req_test_${Date.now()}_${++rid}`;
async function recog(g, { force = false, requestId = newRid(), version = g.version, image = g.image, bytes = small } = {}) {
  const fd = new FormData();
  fd.set("garment_id", g.id); fd.set("image_id", image); fd.set("base_version", String(version)); fd.set("request_id", requestId); if (force) fd.set("force", "1");
  fd.set("file", new Blob([bytes], { type: "image/jpeg" }), "ai.jpg");
  return call("POST", "/api/ai-lab/recognize", { form: fd });
}
const goodJson = (over = {}) => JSON.stringify({ schema_version: 1, suggested_name: "黑粉色蝴蝶結 JSK", category_id: dress.id, subcategory_id: jskId, primary_color_ids: [opt("primary_color", "黑")].filter(Boolean), secondary_color_ids: [opt("secondary_colors", "粉紅") ?? opt("secondary_colors", "粉")].filter(Boolean), style_ids: [opt("style", "Sweet Lolita")].filter(Boolean), season_ids: [], attributes: {}, pattern: "純色", decorations: ["蝴蝶結"], brand_candidate: null, description: "黑色 JSK，胸前有粉色蝴蝶結", has_multiple_items: false, is_full_outfit: false, review_required: true, uncertain_fields: [], warnings: [], ...over });
const reply = (text, usage = { prompt_tokens: 3000, completion_tokens: 200 }) => ({ response: text, usage });
const setLab = (b) => call("POST", "/api/ai-lab/settings", { body: b });
const day = new Date().toISOString().slice(0, 10);
const daily = async () => (await env.DB.prepare("SELECT * FROM ai_usage_daily WHERE day = ?").bind(day).first()) ?? { requests: 0, neurons: 0, inflight: 0 };
const resetUsage = async () => { await env.DB.prepare("DELETE FROM ai_usage_daily").run(); await env.DB.prepare("DELETE FROM ai_usage_monthly").run(); };

console.log("Validator（純函數）");
{
  const v = validateAiOutput(JSON.parse(goodJson()), tax);
  check("有效輸出：主分類／子分類轉為名稱", v.ok && v.fields.category === "連身裙" && v.fields.subcategory === "JSK", v);
  const bad = validateAiOutput(JSON.parse(goodJson({ category_id: "cat_fake", subcategory_id: "x" })), tax);
  check("不存在的分類 ID → 留空並標記不確定", bad.fields?.category === null && bad.fields.uncertain_fields.includes("category"), bad);
  const wrongSub = validateAiOutput(JSON.parse(goodJson({ category_id: skirt.id, subcategory_id: jskId })), tax);
  check("子分類不屬於主分類 → 留空", wrongSub.fields.subcategory === null && wrongSub.warnings.some((w) => /不屬於/.test(w)), wrongSub.warnings);
  const sleeve = tax.attributes.find((a) => a.show_for?.length && !a.show_for.includes(skirt.id) && a.options.length);
  if (sleeve) {
    const na = validateAiOutput(JSON.parse(goodJson({ category_id: skirt.id, subcategory_id: null, attributes: { [sleeve.id]: sleeve.options[0].id } })), tax);
    check(`不適用屬性（${sleeve.name}）不會套用於半身裙`, !na.attributes[sleeve.id], na.attributes);
  } else check("（taxonomy 沒有限定分類的屬性，略過）", true);
  const long = validateAiOutput(JSON.parse(goodJson({ suggested_name: "<script>alert(1)</script>" + "長".repeat(500), description: "<img src=x onerror=alert(1)>描述" })), tax);
  check("超長文字截斷、HTML／Script 移除", long.fields.name.length <= 60 && !/[<>]/.test(long.fields.name) && !/[<>]/.test(long.fields.details), long.fields);
  const extra = validateAiOutput({ ...JSON.parse(goodJson()), sql: "DROP TABLE garments", delete_garment: true }, tax);
  check("未知欄位（SQL、刪除指令）被移除", extra.ok && !("sql" in extra.fields) && extra.warnings.some((w) => /未知欄位/.test(w)));
  const many = validateAiOutput(JSON.parse(goodJson({ primary_color_ids: attr("primary_color").options.slice(0, 5).map((o) => o.id) })), tax);
  check("多選上限（主色最多 2 個）", many.fields.primary_color.split("、").length <= (attr("primary_color").max_select ?? 2), many.fields.primary_color);
  check("extractJson 容許 ``` 包裝及前後文字", extractJson("好的：```json\n{\"a\":{\"b\":1}}\n``` 完") .a.b === 1);
  let threw = false; try { extractJson("not json"); } catch { threw = true; }
  check("無效 JSON 拋錯", threw);
  check("cleanText 移除控制字元", cleanText("a\u0000b", 10) === "a b");
  check("品牌只作候選", validateAiOutput(JSON.parse(goodJson({ brand_candidate: "Angelic Pretty" })), tax).fields.brand_confidence === "unconfirmed");
}

console.log("權限及開關");
{
  const anon = await call("GET", "/api/ai-lab/status", { noAuth: true });
  check("未登入不能使用 AI Lab", anon.status === 401, anon.status);
  const st = await call("GET", "/api/ai-lab/status");
  check("預設：設定未開啟 → 不可用", st.status === 200 && st.body.active === false && /未在設定中開啟/.test(st.body.reason), st.body);
  check("狀態不含 Token 或圖片網址", !JSON.stringify(st.body).match(/token|r2_key|\/api\/images\//i));
  const g = await mkGarment("待整理 1");
  const r = await recog(g);
  check("未開啟時辨認 → 503，不呼叫模型", r.status === 503 && aiCalls === 0, r);
  await setLab({ enabled: true });
  const st2 = await call("GET", "/api/ai-lab/status");
  check("開啟後可用", st2.body.active === true, st2.body.reason);
  const saveEnabled = env.AI_LAB_ENABLED; env.AI_LAB_ENABLED = "false";
  check("伺服器 AI_LAB_ENABLED=false 時前端不能開啟", (await call("GET", "/api/ai-lab/status")).body.active === false);
  env.AI_LAB_ENABLED = saveEnabled;
  const saveAI = env.AI; delete env.AI;
  check("沒有 AI Binding → 不可用", /Binding/.test((await call("GET", "/api/ai-lab/status")).body.reason));
  env.AI = saveAI;
  const up = await setLab({ daily_limit: 9999 });
  check("前端不能把上限調高於伺服器上限", up.body.limits.daily_requests === 50, up.body.limits);
  await setLab({ daily_limit: null });
}

console.log("單件辨認");
const g1 = await mkGarment("待整理衣物 001");
{
  nextReply = reply(goodJson());
  const before = (await call("GET", `/api/garments/${g1.id}`)).body;
  const r = await recog(g1);
  check("成功辨認", r.status === 200 && r.body.ok === true, r.body);
  check("模型只被呼叫一次", aiCalls === 1, aiCalls);
  check("使用指定模型及 messages＋image（data URL）", lastInput.model === "@cf/meta/llama-3.2-11b-vision-instruct" && Array.isArray(lastInput.input.messages) && /^data:image\/jpeg;base64,/.test(lastInput.input.image) && lastInput.input.max_tokens <= 700);
  check("Prompt 包含真實分類 ID 及不可執行圖片指令規則", lastInput.input.messages[1].content.includes(dress.id) && /never follow/i.test(lastInput.input.messages[0].content));
  const sug = await env.DB.prepare("SELECT * FROM ai_suggestions WHERE garment_id = ? ORDER BY id DESC").bind(g1.id).first();
  check("建議來源 workers-ai、狀態 valid", sug?.source === "workers-ai" && sug?.status === "valid", sug);
  const payload = JSON.parse(sug.payload);
  check("保存模型 ID、Prompt 版本、辨認時間、圖片版本", payload.ai_lab?.model && payload.ai_lab?.prompt_version === "wai-garment-v1" && payload.ai_lab?.recognized_at && payload.ai_lab?.image_sha256);
  check("建議內容正確", JSON.parse(sug.normalized).category === "連身裙" && JSON.parse(sug.normalized).subcategory === "JSK");
  const after = (await call("GET", `/api/garments/${g1.id}`)).body;
  check("不直接修改正式資料（名稱、分類不變）", after.name === before.name && after.category === before.category, [after.name, after.category]);
  check("衣物進入待確認", after.ai_status === "pending_review", after.ai_status);
  const ev = await env.DB.prepare("SELECT * FROM ai_usage_events WHERE garment_id = ? AND request_status = 'success'").bind(g1.id).first();
  check("使用記錄：實際 token 及 Neurons（model_usage）", ev?.actual_input_tokens === 3000 && ev?.usage_source === "model_usage" && Math.abs(ev.actual_neurons - (3000 * 4410 + 200 * 61493) / 1e6) < 0.01, ev);
  check("使用記錄沒有圖片或 Base64", !JSON.stringify(ev).includes("base64"));
  const d = await daily();
  check("每日計數：1 次、inflight 歸零、Neurons 按實際結算", d.requests === 1 && d.inflight === 0 && Math.abs(d.neurons - ev.actual_neurons) < 0.01, d);

  const c = await recog({ ...g1, version: after.version });
  check("相同圖片再次辨認 → 使用快取，不呼叫模型", c.body.cached === true && aiCalls === 1, c.body);
  const dupId = newRid();
  nextReply = reply(goodJson());
  const f1 = await recog({ ...g1, version: after.version }, { force: true, requestId: dupId });
  check("重新辨認（force）→ 再呼叫一次", f1.status === 200 && aiCalls === 2, f1.body);
  const g1v = (await call("GET", `/api/garments/${g1.id}`)).body.version;
  const f2 = await recog({ ...g1, version: g1v }, { force: true, requestId: dupId });
  check("重複 request_id → 不再呼叫模型", f2.body.replay === true && aiCalls === 2, f2.body);
  const stale = await recog({ ...g1, version: g1v - 1 }, { force: true });
  check("過時衣物版本 → 409，不呼叫模型", stale.status === 409 && aiCalls === 2, stale);
  const other = await mkGarment("其他衣物");
  const foreign = await recog({ ...g1, version: g1v }, { image: other.image, force: true });
  check("圖片不屬於該衣物 → 400", foreign.status === 400 && aiCalls === 2, foreign.body);
  const big = new Uint8Array(await sharp({ create: { width: 2000, height: 2000, channels: 3, background: "#fff" } }).jpeg().toBuffer());
  const bigR = await recog({ ...g1, version: g1v }, { bytes: big, force: true });
  check("辨認圖過大（長邊 > 1100）→ 400，不呼叫模型", bigR.status === 400 && aiCalls === 2, bigR.body);
}

console.log("異常輸出");
{
  const g = await mkGarment("待整理 異常");
  nextReply = reply("對不起，我不能輸出 JSON");
  const before = aiCalls;
  const r = await recog(g);
  check("無效 JSON → 最多重試一次（共 2 次呼叫）", aiCalls - before === 2, aiCalls - before);
  const evs = (await env.DB.prepare("SELECT operation_type FROM ai_usage_events WHERE garment_id = ? ORDER BY created_at").bind(g.id).all()).results.map((e) => e.operation_type);
  check("重試亦計入使用記錄", evs.join() === "recognize,retry", evs);
  const after = (await call("GET", `/api/garments/${g.id}`)).body;
  check("輸出不合格 → 標示需要手動整理（failed）", r.status === 200 && r.body.ok === false && after.ai_status === "failed", [r.body, after.ai_status]);
  const g2 = await mkGarment("待整理 空白");
  nextReply = reply("");
  const r2 = await recog(g2);
  check("AI 回傳空內容 → 需要手動整理", r2.body.ok === false);
  const g3 = await mkGarment("待整理 非法分類");
  nextReply = reply(goodJson({ category_id: "cat_nope", subcategory_id: "sub_nope", suggested_name: "某衣物" }));
  const r3 = await recog(g3);
  check("不存在的分類 ID → 建議保留其他欄位、分類留空", r3.body.ok === true && JSON.parse((await env.DB.prepare("SELECT normalized FROM ai_suggestions WHERE garment_id = ?").bind(g3.id).first()).normalized).category === null);
  const g4 = await mkGarment("待整理 品牌");
  nextReply = reply(goodJson({ brand_candidate: "Angelic Pretty" }));
  await recog(g4);
  const n4 = JSON.parse((await env.DB.prepare("SELECT normalized FROM ai_suggestions WHERE garment_id = ?").bind(g4.id).first()).normalized);
  check("品牌不會寫入已確認欄位（只作候選）", n4.brand === null && n4.brand_candidate === "Angelic Pretty" && n4.brand_confidence === "unconfirmed", n4);
}

console.log("服務錯誤");
{
  await resetUsage();
  const g = await mkGarment("待整理 錯誤");
  nextReply = new Error("AiError: 5016: User has not agreed to Llama3.2 model terms");
  const lic = await recog(g);
  check("未接受 Meta 授權 → 403 license_required（不自動接受）", lic.status === 403 && lic.body.error?.code === "license_required" || lic.body.code === "license_required", lic.body);
  check("沒有自動送出 agree", lastInput.input.prompt !== "agree");
  let d = await daily();
  check("授權錯誤不計費：Neurons 退回", d.neurons === 0 && d.inflight === 0, d);
  nextReply = new Error("Network connection lost");
  const un = await recog(g);
  check("服務不可用 → 502", un.status === 502, un.status);
  d = await daily();
  check("不確定是否計費 → 保留預算預留（不當作零成本）", d.neurons > 50 && d.inflight === 0, d);
  const ev = await env.DB.prepare("SELECT request_status FROM ai_usage_events WHERE error_code = 'unavailable'").first();
  check("記錄為 uncertain", ev?.request_status === "uncertain", ev);
  nextReply = new Error("4006: you have used up your daily free allocation of 10,000 neurons");
  const q = await recog(g);
  check("Workers AI 免費額度用完 → 429", q.status === 429, q.status);
}

console.log("配額及並行");
{
  await resetUsage();
  await setLab({ daily_limit: 2 });
  const g = await mkGarment("待整理 配額");
  nextReply = reply(goodJson());
  const before = aiCalls;
  await recog(g, { force: true });
  let v = (await call("GET", `/api/garments/${g.id}`)).body.version;
  await recog({ ...g, version: v }, { force: true });
  v = (await call("GET", `/api/garments/${g.id}`)).body.version;
  const third = await recog({ ...g, version: v }, { force: true });
  check("每日上限 → 429 daily_limit，且不呼叫模型", third.status === 429 && aiCalls - before === 2, [third.body, aiCalls - before]);
  await setLab({ daily_limit: null, monthly_limit: 1 });
  await resetUsage();
  await recog({ ...g, version: v }, { force: true });
  v = (await call("GET", `/api/garments/${g.id}`)).body.version;
  const m = await recog({ ...g, version: v }, { force: true });
  check("每月上限 → 429 monthly_limit", m.status === 429 && /本月/.test(JSON.stringify(m.body)), m.body);
  check("每月上限失敗時每日預留已回滾", (await daily()).requests === 1, await daily());
  await setLab({ monthly_limit: null });
  await resetUsage();
  // 並行：3 個同時請求，AI_MAX_CONCURRENCY=1
  aiDelay = 80;
  const gs = await Promise.all([mkGarment("並行 A"), mkGarment("並行 B"), mkGarment("並行 C")]);
  const before2 = aiCalls;
  const rs = await Promise.all(gs.map((x) => recog(x)));
  aiDelay = 0;
  const ok = rs.filter((x) => x.status === 200).length, busy = rs.filter((x) => x.status === 429).length;
  check("同時多個請求不能突破並行限制（只 1 個執行）", ok === 1 && busy === 2 && aiCalls - before2 === 1, rs.map((x) => x.status));
  await resetUsage();
  await setLab({ neuron_budget: 100 });
  let n = 0, last;
  const gb = await mkGarment("預算");
  for (let i = 0; i < 6; i++) { const vv = (await call("GET", `/api/garments/${gb.id}`)).body.version; last = await recog({ ...gb, version: vv }, { force: true }); if (last.status === 200) n++; else break; }
  check("Neuron 預算到達上限後停止（預留最壞情況）", last.status === 429 && /neuron_budget/.test(JSON.stringify(last.body)) && n >= 1, [n, last.body]);
  check("今日 Neurons 不超過預算", (await daily()).neurons <= 100, await daily());
  await setLab({ neuron_budget: null });
}

console.log("Kill Switch、測試連線、價格");
{
  await resetUsage();
  const sugBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_suggestions").first()).n;
  await setLab({ killed: true });
  const g = await mkGarment("待整理 停止");
  const before = aiCalls;
  const r = await recog(g);
  check("Kill Switch → 停止新請求", r.status === 503 && aiCalls === before && /Kill/.test(JSON.stringify(r.body)));
  check("Kill Switch 保留已有 AI 建議", (await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_suggestions").first()).n === sugBefore);
  check("Kill Switch 不影響普通衣櫃操作", (await call("GET", "/api/garments")).status === 200);
  await setLab({ killed: false });
  nextReply = reply("OK", { prompt_tokens: 20, completion_tokens: 1 });
  const t = await call("POST", "/api/ai-lab/test");
  check("測試連線實際呼叫模型並計入配額", t.status === 200 && (await daily()).requests === 1 && aiCalls === before + 1, t.body);
  check("測試連線不傳送圖片", lastInput.input.image === undefined);
  const saveModel = env.AI_MODEL; env.AI_MODEL = "@cf/unknown/paid-model";
  const st = await call("GET", "/api/ai-lab/status");
  check("無法確認模型價格 → 停止新請求", st.body.active === false && /價格/.test(st.body.reason), st.body.reason);
  env.AI_MODEL = saveModel;
  env.AI_DAILY_NEURON_BUDGET = "50000";
  check("AI_PAID_USAGE_ENABLED=false 時預算不超過免費額度 10,000", (await call("GET", "/api/ai-lab/status")).body.limits.daily_neurons === 10000);
  env.AI_DAILY_NEURON_BUDGET = "5000";
  const s2 = (await call("GET", "/api/ai-lab/status")).body;
  check("狀態顯示用量、剩餘額度、價格來源", s2.usage.today.requests === 1 && s2.pricing.source.includes("cloudflare.com") && typeof s2.usage.remaining.neurons_today === "number", s2.usage);
  const evs = await call("GET", "/api/ai-lab/events");
  check("使用記錄 API", evs.status === 200 && evs.body.events.length > 0 && !JSON.stringify(evs.body).includes("base64"));
}

console.log("人工確認：不覆寫鎖定欄位");
{
  await resetUsage();
  const g = await mkGarment("我的命名", "上衣");
  // 使用者手動修改名稱 → 鎖定
  await call("PATCH", `/api/garments/${g.id}`, { body: { name: "我親自改的名稱" } });
  const v = (await call("GET", `/api/garments/${g.id}`)).body.version;
  nextReply = reply(goodJson());
  const r = await recog({ ...g, version: v });
  const sid = r.body.suggestion?.id;
  const dec = await call("POST", `/api/ai/garments/${g.id}/decide`, { body: { suggestion_id: sid, action: "accept_all", version: (await call("GET", `/api/garments/${g.id}`)).body.version } });
  const after = (await call("GET", `/api/garments/${g.id}`)).body;
  check("接受全部建議後：鎖定的名稱沒有被 AI 覆寫", after.name === "我親自改的名稱", [dec.status, after.name]);
  check("未鎖定欄位按建議更新（沿用現有正式入庫流程）", after.category === "連身裙", after.category);
}

console.log(`\n${passed} 項通過，${failures.length} 項失敗`);
if (failures.length) { console.log("失敗：", failures.join("、")); process.exit(1); }
