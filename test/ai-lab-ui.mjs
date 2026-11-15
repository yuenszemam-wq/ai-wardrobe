// AI Lab UI：設定頁（狀態、開關、Kill Switch、上限、測試連線、紀錄）、衣物詳情「AI 自動辨認」、AI 待整理批量辨認。
// 以 Mock env.AI 執行，不呼叫真正 Workers AI。執行：node test/ai-lab-ui.mjs（桌面瀏覽器模擬手機，不等於 iPhone 實機）
import { join } from "node:path";
import { startApp, addGarment, checker } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("ailabui");
const { env, page } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `ailab-${n}.png`) });
let aiCalls = 0;
Object.assign(env, {
  AI_LAB_ENABLED: "true", AI_PROVIDER: "workers-ai", AI_MODEL: "@cf/meta/llama-3.2-11b-vision-instruct", AI_DAILY_REQUEST_LIMIT: "50", AI_MONTHLY_REQUEST_LIMIT: "500",
  AI_MAX_BATCH_SIZE: "10", AI_MAX_CONCURRENCY: "1", AI_DAILY_NEURON_BUDGET: "5000", AI_PAID_USAGE_ENABLED: "false",
  AI: { async run(model, input) {
    aiCalls++;
    if (!input.image) return { response: "OK", usage: { prompt_tokens: 10, completion_tokens: 1 } };
    const tax = input.messages[1].content;
    const cat = /(\w+)=連身裙/.exec(tax)?.[1];
    return { response: JSON.stringify({ schema_version: 1, suggested_name: "黑色 JSK", category_id: cat, subcategory_id: null, primary_color_ids: [], secondary_color_ids: [], style_ids: [], season_ids: [], attributes: {}, pattern: null, decorations: [], brand_candidate: null, description: "黑色", has_multiple_items: false, is_full_outfit: false, review_required: true, uncertain_fields: ["subcategory"], warnings: [] }), usage: { prompt_tokens: 2500, completion_tokens: 150 } };
  } },
});
await addGarment(env, { id: "gar_a", name: "待整理衣物 001", category: null, subcategory: null, svg: '<rect x="200" y="300" width="500" height="800" fill="#222"/>' });
await addGarment(env, { id: "gar_b", name: "待整理衣物 002", category: null, subcategory: null, svg: '<rect x="200" y="300" width="500" height="800" fill="#522"/>' });
await addGarment(env, { id: "gar_c", name: "待整理衣物 003", category: null, subcategory: null, svg: '<rect x="200" y="300" width="500" height="800" fill="#225"/>' });
await env.DB.prepare("UPDATE garments SET ai_status = 'pending_ai', status = 'review'").run();

try {
  console.log("設定頁");
  await page.goto(A.base + "/settings");
  await page.click('text=AI Lab／AI 實驗室');
  await page.waitForSelector('[data-testid="ai-lab-panel"]');
  check("預設未啟用並顯示原因", (await page.textContent('[data-testid="ai-lab-state"]')) === "未啟用" && /未在設定中開啟/.test(await page.textContent('[data-testid="ai-lab-reason"]')));
  check("頁面沒有顯示 Token 或圖片網址", !/api\/images|CF_API_TOKEN|Bearer/.test(await page.textContent('[data-testid="ai-lab-panel"]')));
  await page.click('[data-testid="ai-lab-toggle"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="ai-lab-state"]')?.textContent === "可使用");
  check("開啟 AI Lab", true);
  await page.click('[data-testid="ai-lab-test"]');
  await page.waitForFunction(() => /1 \/ 50/.test(document.querySelector('[data-ai-row="today"]')?.textContent || ""), null, { timeout: 10000 });
  check("測試連線計入今日呼叫次數", aiCalls === 1);
  await page.fill('[data-testid="ai-lab-limit-daily"]', "20");
  await page.click('[data-testid="ai-lab-save-limits"]');
  await page.waitForFunction(() => /\/ 20/.test(document.querySelector('[data-ai-row="today"]')?.textContent || ""));
  check("設定更低每日上限", true);
  await page.click('[data-testid="ai-lab-events"]');
  await page.waitForSelector("text=測試");
  check("顯示測試紀錄", true);
  await shot("01-settings");

  console.log("衣物詳情：AI 自動辨認");
  await page.goto(A.base + "/g/gar_a");
  await page.waitForSelector('[data-testid="ai-recognize-run"]');
  await page.click('[data-testid="ai-recognize-run"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="ai-recognize-run"]')?.textContent?.includes("辨認中"), null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const sug = await env.DB.prepare("SELECT * FROM ai_suggestions WHERE garment_id = 'gar_a'").first();
  check("產生 workers-ai 建議", sug?.source === "workers-ai" && sug?.status === "valid", sug);
  check("正式資料未被修改", (await env.DB.prepare("SELECT name, category FROM garments WHERE id = 'gar_a'").first()).category === null);
  const lastInput = await env.DB.prepare("SELECT estimated_input_tokens FROM ai_usage_events WHERE garment_id = 'gar_a'").first();
  check("記錄使用量", !!lastInput);
  check("出現「重新辨認」", await page.locator('[data-testid="ai-recognize-force"]').isVisible());
  await shot("02-detail");

  console.log("AI 待整理：批量辨認");
  await page.goto(A.base + "/?tab=pending_ai#todo");
  await page.waitForSelector('[data-testid="ai-batch-open"]', { timeout: 15000 });
  await page.click('[data-testid="ai-batch-open"]');
  await page.waitForSelector('[data-testid="ai-batch"]');
  const n = await page.locator("[data-batch-item]").count();
  check("批量清單列出待辨認衣物", n >= 2, n);
  const firstId = await page.locator("[data-batch-item]").first().getAttribute("data-batch-item");
  await page.locator(`[data-batch-item="${firstId}"] >> text=取消`).click();
  const before = aiCalls;
  await page.click('[data-testid="ai-batch-start"]');
  await page.waitForFunction(() => /未處理 0/.test(document.querySelector('[data-testid="ai-batch-counts"]')?.textContent || "") && !document.querySelector('[data-batch-item][data-state="running"]'), null, { timeout: 20000 });
  check("逐件處理、被取消的項目沒有呼叫 AI", aiCalls - before === n - 1, [aiCalls - before, n]);
  check("取消的項目標示為已取消", (await page.getAttribute(`[data-batch-item="${firstId}"]`, "data-state")) === "cancelled");
  await shot("03-batch");

  console.log("Kill Switch");
  await page.goto(A.base + "/settings/ai-lab");
  await page.waitForSelector('[data-testid="ai-lab-kill"]');
  await page.click('[data-testid="ai-lab-kill"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="ai-lab-state"]')?.textContent === "未啟用");
  await page.goto(A.base + "/g/gar_b");
  await page.waitForSelector('[data-testid="studio-start"], h1');
  await page.waitForTimeout(500);
  check("Kill Switch 後衣物詳情不顯示 AI 按鈕", (await page.locator('[data-testid="ai-recognize-run"]').count()) === 0);
} catch (e) {
  console.error(e);
  check("測試沒有例外", false, String(e?.stack || e));
  await shot("error").catch(() => {});
} finally {
  done();
  await A.close?.();
  process.exit(process.exitCode || 0);
}
