// Phase 3.8B.1：R2 儀表板數據可靠性（每日官方數據、缺失日期、未知操作、精確百分比、超額、月底估算、過時數據、冷卻、不掃描 R2）。
// 執行：node test/phase38b1.mjs   （本機模擬 D1／R2，不接觸正式服務）
import { makeEnv } from "./harness.mjs";
import { buildWorker, buildModule } from "./doll-build.mjs";
import { checker, hex, now } from "./p38-setup.mjs";

const { check, done } = checker();
const R = await buildModule("worker/r2usage.ts", "p38b1-r2");
const F = await buildModule("src/r2format.ts", "p38b1-fmt");
const worker = await buildWorker("p38b1-worker");

const day = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);

try {
  console.log("操作分類");
  check("官方 Class A／B／免費分類", R.classOf("PutObject") === "class_a" && R.classOf("ListObjects") === "class_a" && R.classOf("GetObject") === "class_b" && R.classOf("HeadObject") === "class_b" && R.classOf("DeleteObject") === "free" && R.classOf("AbortMultipartUpload") === "free");
  check("文件沒有列出的操作：unknown（不當作免費）", R.classOf("SomeFutureOp") === "unknown");

  console.log("每日官方數據：缺失日期與真正零用量");
  const nowD = new Date(Date.UTC(2026, 10, 15, 6, 0, 0)); // 11 月 15 日
  const start = new Date(Date.UTC(2026, 9, 17)); // 30 日前（跨月）
  const ops = [
    { sum: { requests: 100 }, dimensions: { date: "2026-10-20", actionType: "GetObject", bucketName: "ai-wardrobe-images" } }, // 上月：不計入本月
    { sum: { requests: 1000 }, dimensions: { date: "2026-11-01", actionType: "GetObject", bucketName: "ai-wardrobe-images" } },
    { sum: { requests: 10 }, dimensions: { date: "2026-11-01", actionType: "PutObject", bucketName: "ai-wardrobe-images" } },
    { sum: { requests: 2000 }, dimensions: { date: "2026-11-02", actionType: "GetObject", bucketName: "ai-wardrobe-images" } },
    { sum: { requests: 5 }, dimensions: { date: "2026-11-02", actionType: "MysteryOp", bucketName: "other-project" } },
    { sum: { requests: 3000 }, dimensions: { date: "2026-11-04", actionType: "GetObject", bucketName: "ai-wardrobe-preview-images" } },
    { sum: { requests: 7 }, dimensions: { date: "2026-11-15", actionType: "GetObject", bucketName: "ai-wardrobe-images" } },
  ];
  const st = [
    { max: { payloadSize: 5e8, metadataSize: 0, objectCount: 500 }, dimensions: { date: "2026-11-01", bucketName: "ai-wardrobe-images" } },
    { max: { payloadSize: 6e8, metadataSize: 0, objectCount: 600 }, dimensions: { date: "2026-11-02", bucketName: "ai-wardrobe-images" } },
    { max: { payloadSize: 1e8, metadataSize: 0, objectCount: 50 }, dimensions: { date: "2026-11-02", bucketName: "ai-wardrobe-preview-images" } },
  ];
  const off = R.buildOfficial({ ops, st }, nowD, start, true);
  const d = Object.fromEntries(off.daily.days.map((r) => [r.date, r]));
  check("本月合計只計本月日期（上月 100 次不計）", off.account.class_b === 1000 + 2000 + 3000 + 7 && off.account.class_a === 10, off.account);
  check("未知操作分開統計並列出名稱", off.account.unknown === 5 && off.account.unknown_actions.join() === "MysteryOp");
  check("每日資料涵蓋最近 30 日（跨月）", off.daily.days.length === 30 && off.daily.days[0].date === "2026-10-17" && off.daily.days.at(-1).date === "2026-11-15");
  check("沒有官方資料的日期＝null（不是 0）", d["2026-11-03"].class_b === null && d["2026-11-03"].storage_bytes === null);
  check("有資料的日期：同日其他類別確實為 0", d["2026-11-04"].class_a === 0 && d["2026-11-04"].class_b === 3000);
  check("今日標示未完結", d["2026-11-15"].partial === true && !d["2026-11-14"].partial);
  check("每日容量＝各 Bucket 總和", d["2026-11-02"].storage_bytes === 7e8);
  check("目前容量＝各 Bucket 最新一日", off.account.storage_bytes === 6e8 + 1e8);
  check("GB-month（估算）＝本月每日最高容量總和 ÷ 30 日（不是目前容量）", Math.abs(off.account.gb_month_est - (5e8 + 7e8) / 1e9 / 30) < 1e-12 && off.account.storage_days === 2, off.account.gb_month_est);
  check("Bucket 分開：正式、預覽、其他專案", off.buckets["ai-wardrobe-images"].class_b === 3007 && off.buckets["ai-wardrobe-preview-images"].class_b === 3000 && off.buckets["other-project"].unknown === 5);

  console.log("費用：向上取整、未知不當作 0");
  check("免費額度內：US$0", R.costOf({ class_a: 999_999, class_b: 9_999_999, gb_month: 9.99 }).total === 0);
  const c1 = R.costOf({ class_a: 1_000_001, class_b: 0, gb_month: 0 });
  check("超出 1 次 Class A：按 100 萬次計（US$4.50）", Math.abs(c1.class_a - 4.5) < 1e-9 && Math.abs(c1.total - 4.5) < 1e-9, c1);
  const c2 = R.costOf({ class_a: 0, class_b: 0, gb_month: 11.1 });
  check("超出 1.1 GB-month：按 2 GB-month 計（US$0.03）", Math.abs(c2.storage - 0.03) < 1e-9, c2);
  const c3 = R.costOf({ class_a: 0, class_b: 0, gb_month: null });
  check("儲存計費資料缺失：總費用未知（null），不是 0", c3.storage === null && c3.total === null && c3.partial === true && c3.known === 0);
  check("有未知操作：標示部分費用未能估算", R.costOf({ class_a: 0, class_b: 0, gb_month: 1, unknown: 5 }).partial === true);

  console.log("顯示：極低及超過 100% 的比例");
  check("0.067% 不會顯示為 0%", F.fmtPct(0.00067) === "0.067%", F.fmtPct(0.00067));
  check("0.0000123 → <0.001%", F.fmtPct(0.0000000123) === "<0.001%", F.fmtPct(0.0000000123));
  check("真正零 → 0%", F.fmtPct(0) === "0%");
  check("12.34%", F.fmtPct(0.12345) === "12.3%", F.fmtPct(0.12345));
  const q = F.quota(1_500_000, 1_000_000);
  check("超過 100%：進度條滿格，文字顯示真實比例及超出量", q.bar === 1 && q.label === "150%" && q.over === 500_000 && q.remaining === 0, q);
  const q0 = F.quota(667, 1_000_000);
  check("Class A 667 次：0.067%，剩餘 999,333", q0.label === "0.067%" && q0.remaining === 999_333 && q0.bar > 0 && q0.bar < 0.01, q0);
  check("缺失數據：顯示未知（不是 0%）", F.quota(null, 10).label === "未知" && F.quota(null, 10).bar === 0);

  console.log("月底估算");
  const thin = R.forecast(off);
  check("完整日子不足 3 日：暫未有足夠資料（不輸出虛假預測）", thin.available === false && /暫未有足夠資料/.test(thin.reason), thin);
  const ops2 = [];
  for (let i = 1; i <= 14; i++) ops2.push({ sum: { requests: 1000 }, dimensions: { date: `2026-11-${String(i).padStart(2, "0")}`, actionType: "GetObject", bucketName: "b" } }, { sum: { requests: 10 }, dimensions: { date: `2026-11-${String(i).padStart(2, "0")}`, actionType: "PutObject", bucketName: "b" } });
  ops2.push({ sum: { requests: 99 }, dimensions: { date: "2026-11-15", actionType: "GetObject", bucketName: "b" } });
  const st2 = Array.from({ length: 14 }, (_, i) => ({ max: { payloadSize: 3e9, metadataSize: 0, objectCount: 1 }, dimensions: { date: `2026-11-${String(i + 1).padStart(2, "0")}`, bucketName: "b" } }));
  const off2 = R.buildOfficial({ ops: ops2, st: st2 }, nowD, start, true);
  const fc = R.forecast(off2);
  check("月底 Class B：已完結 14 日 × 1000 → 30 日 30,000（不計今日未完結的 99）", fc.available && fc.class_b === 30_000 && fc.class_a === 300, fc);
  check("月底 GB-month：容量 3 GB 維持 → 3 GB-month", fc.available && Math.abs(fc.gb_month - 3) < 1e-9, fc.gb_month);
  check("估算列出使用的日期範圍及假設", fc.basis.from === "2026-11-01" && fc.basis.to === "2026-11-14" && fc.basis.days === 14 && /假設/.test(fc.assumptions));
  check("月底估算費用（免費額度內）＝0", fc.cost.total === 0);

  console.log("API：冷卻、去重、過時數據、背景保護、不掃描 R2");
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-P38B1-1234")), now()).run();
  const auth = await worker.fetch(new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-P38B1-1234", username: "tester", password: "test-password-1234" }) }), env);
  const cookie = auth.headers.get("set-cookie").split(";")[0];
  const envOff = { ...env, CF_API_TOKEN: "t", CF_ACCOUNT_ID: "acc" };
  let listCalls = 0;
  const realList = envOff.IMAGES.list?.bind(envOff.IMAGES);
  envOff.IMAGES = new Proxy(envOff.IMAGES, { get(t, p) { if (p === "list") return (...a) => { listCalls++; return realList?.(...a); }; const v = Reflect.get(t, p); return typeof v === "function" ? v.bind(t) : v; } });
  const call = async (path) => (await (await worker.fetch(new Request("http://localhost" + path, { headers: { cookie } }), envOff)).json());
  const realFetch = globalThis.fetch;
  let calls = 0, mode = "first";
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("https://api.cloudflare.com/")) return realFetch(url, init);
    calls++;
    if (mode === "fail") return new Response("busy", { status: 503 });
    if (mode === "schema") {
      const body = JSON.parse(init.body);
      if (body.query.includes("date actionType")) return Response.json({ errors: [{ message: "unknown field date in dimensions" }] });
      return Response.json({ data: { viewer: { accounts: [{ ops: [{ sum: { requests: 42 }, dimensions: { actionType: "GetObject", bucketName: "x" } }], st: [] }] } } });
    }
    return Response.json({ data: { viewer: { accounts: [{ ops: [{ sum: { requests: 500 }, dimensions: { date: day(new Date()), actionType: "GetObject", bucketName: "ai-wardrobe-images" } }], st: [{ max: { payloadSize: 1e9, metadataSize: 0, objectCount: 10 }, dimensions: { date: day(new Date()), bucketName: "ai-wardrobe-images" } }] }] } } });
  };
  const age = (key, sec) => env.DB.prepare("UPDATE app_settings SET updated_at = ? WHERE key = ?").bind(new Date(Date.now() - sec * 1000).toISOString(), key).run();
  let u = await call("/api/r2/usage");
  check("官方數據成功：附每日資料", u.official.available && u.official.daily.available && u.official.daily.days.length >= 28 && u.official.daily.days.at(-1).class_b === 500, u.official.daily?.days?.at(-1));
  check("沒有每日資料的日子（今日以外）＝null", u.official.daily.days.slice(0, -1).every((r) => r.class_b === null));
  check("App 估算與官方分開：free_use 來源為官方", u.free_use.source === "official" && u.forecast.available === false);
  check("讀取用量頁不會列出／掃描 R2 Bucket", listCalls === 0);
  const n1 = calls;
  await call("/api/r2/usage?refresh=1");
  check("冷卻期內手動重新整理不重複請求 Cloudflare", calls === n1);
  await age("r2_official_cache", 40);
  mode = "fail";
  u = await call("/api/r2/usage?refresh=1");
  check("官方請求失敗：保留最後一次成功數據並標明可能已過時", calls === n1 + 1 && u.official.available && u.official.stale && u.official.daily.days.at(-1).class_b === 500 && u.official.stale_reason === "api_error");
  u = await call("/api/r2/usage");
  check("失敗結果短暫快取：重開頁面不會再次請求", calls === n1 + 1 && u.official.stale);
  await age("r2_official_cache", 200);
  mode = "schema";
  u = await call("/api/r2/usage?refresh=1");
  check("每日維度不可用：改用本月合計查詢（不偽造每日數據）", u.official.available && !u.official.stale && u.official.daily.available === false && u.official.account.class_b === 42 && u.official.daily.days.length === 0, u.official.daily);
  check("儲存資料缺失：GB-month 未知，總費用 null（不是 US$0）", u.official.account.gb_month_est === null && u.cost.total === null && u.cost.partial === true);
  globalThis.fetch = realFetch;
  // 背景保護：過時官方數據仍然計算；沒有官方數據用 App 統計
  await env.DB.prepare("DELETE FROM app_settings WHERE key IN ('r2_official_cache','r2_official_last_ok')").run();
  const month = new Date().toISOString().slice(0, 7);
  await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('r2_official_last_ok', ?, ?)").bind(JSON.stringify({ available: true, fetched_at: new Date(Date.now() - 72 * 3600e3).toISOString(), account: { class_a: 0, class_b: 9_600_000, free: 0, unknown: 0, unknown_actions: [], storage_bytes: 0, objects: 0, gb_month_est: 0, storage_days: 0, days: 1, days_in_month: 30, month } }), new Date(Date.now() - 72 * 3600e3).toISOString()).run();
  let bg = await R.backgroundAllowed(env);
  check("過時官方數據已超過軟上限：仍暫停非必要背景工作並註明過時", bg.allowed === false && bg.stale === true && /過時/.test(bg.reason), bg);
  await env.DB.prepare("DELETE FROM app_settings WHERE key = 'r2_official_last_ok'").run();
  bg = await R.backgroundAllowed(env);
  check("沒有官方數據及 App 用量低：允許（正常功能不受影響）", bg.allowed === true && bg.source === "app_estimate", bg);
  await env.DB.prepare("INSERT INTO r2_usage (month, env, purpose, op, n, updated_at) VALUES (?, 'test', 'processed', 'class_b', 9500000, ?)").bind(month, now()).run();
  bg = await R.backgroundAllowed(env);
  check("沒有官方數據但 App 統計已達軟上限：暫停背景工作", bg.allowed === false && bg.source === "app_estimate", bg);
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
} finally {
  done();
}
