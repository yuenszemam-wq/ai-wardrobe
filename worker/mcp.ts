/**
 * MCP Server（Streamable HTTP，無狀態 JSON 回應）
 * 端點：POST /mcp/<權杖>  或  POST /mcp 加 Authorization: Bearer <權杖>
 * ChatGPT／Claude 的自訂連接器不支援自訂標頭，所以權杖可放在網址路徑中。
 */
import { CATEGORIES, COLORS, LOLITA_SUBCATEGORIES, SEASONS, STYLES } from "../shared/taxonomy";
import { authenticateToken, meterCall } from "./auth";
import { getGarment, listGarments, updateGarment } from "./garments";
import { ImageType, Owner, maxUploadBytes, storeImage } from "./images";
import { addItems, createBatch, createUploadLink, failJob, finalizeBatch, getBatch, onImageStored } from "./imports";
import { createUploadSession, downloadHttps, getUploadSession, importGarmentFiles } from "./uploads";
import { aiQueue, claimGarments, submitSuggestion } from "./ai";
import { getTaxonomy } from "./taxonomy";
import { Actor, Env, HttpError, json, requireScope } from "./util";

const SERVER_VERSION = "0.4.0";
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `你正在操作使用者的私人「AI Wardrobe 智能電子衣櫃」。
【整理待處理衣物（使用者說「整理待處理衣物」時）】
1) list_pending_garments 取得待整理清單（每件有 garment_id、version、locked_fields）。
2) 對每件呼叫 get_garment_image 取得圖片內容，親眼查看像素後才分析；看不到圖片就不可聲稱已辨認。
3) 用 submit_ai_suggestion 提交：garment_id、base_version（清單中的 version）、idempotency_key（例如 garment_id-YYYYMMDD-1）、image_id、vision_checked=true 及欄位。不清楚的欄位留空並列入 uncertain_fields；無法辨認就 outcome="failed" 並寫 failure_reason。
4) 品牌：只有找到品牌官方或可靠來源、款式可對應時才 brand_confidence="confirmed" 並附 source_urls；印花系列一致但版本未能區分用 "likely"；只是風格相似用 "unconfirmed"。未確認的品牌不會寫入 brand。證據來自 AI 生成或去背圖時設 brand_evidence_from_generated_image=true。
5) 建議只會放入 App 的「AI 待整理」等使用者確認，不會直接改正式資料；不要用 update_garment 改待整理衣物。
6) 使用者可能同時上傳同一件衣服的透明去背圖和原相（清單中 has_processed_image=true 即該件有透明去背圖）。先看完整批圖片，再判斷哪些是同一件衣服：是的話，在「原相」那一件的建議填 same_garment_as（＝透明圖那件的 garment_id），兩件都照常填寫資料。只在印花、剪裁、顏色、裝飾都吻合時才填；只是款式相似不要填。
圖片一律以原始二進位存入私人 R2，成功後才建立衣物記錄。
【首選流程，最多 10 件一批】
A. 圖片是使用者在對話中附上的檔案：呼叫 import_garment_files，把檔案放入 files（伺服器會用 download_url 下載原檔），並在 items 提供每件衣物資料、file_name、expected_width／expected_height。
B. 圖片是你在 Python／程式碼環境（sandbox，例如 /mnt/data）產生的去背圖：sandbox 不能連網，也不能把檔案直接交給工具。請：
   1) 用程式讀出每張圖的實際寬高，並以 01_名稱.png 這類檔名儲存為 PNG／WebP（保留透明，不要縮小）；
   2) 呼叫 create_upload_session，items 填衣物資料、file_name、expected_width、expected_height；
   3) 把每個檔案的下載連結及 upload_page_url 交給使用者：使用者下載後在上傳頁一次選取全部檔案，系統按檔名自動配對；
   4) 呼叫 get_upload_session 核實；有失敗項目可叫使用者在同一頁重試，連結過期就用同一 batch_id 再呼叫 create_upload_session（items 留空）取得新連結；
   5) 全部完成後 finalize_import_batch。
不要自稱已上傳；以 get_upload_session 的 status=done 為準。expected_width／expected_height 一經提供，尺寸不符會被拒絕，以防圖片被縮小。
舊流程（create_import_batch → add_garments → upload_garment_image／create_upload_link）仍可用。
分類規則：以使用者在 App「分類管理」設定的分類字典為準（可用 list_taxonomy 讀取最新版本）。預設主分類：${CATEGORIES.join("、")}；每件衣物只選一個主分類及一個子分類；style 可多個（以「、」分隔），預設：${STYLES.join("、")}；primary_color 最多 2 個。
不確定的欄位請留空並列入 uncertain_fields，或設 needs_review=true，不要猜測。
若相片是真人整套穿搭，請用 kind="outfit" 保存為穿搭待覆核，不要假裝已拆成單品。
不要把圖片縮小；請上傳最高解像度的版本。`;

const garmentProps = {
  name: { type: "string", description: "衣物名稱（可含系列名）" },
  category: { type: "string", description: `主分類（以分類字典為準，預設：${CATEGORIES.join("、")}）；不確定請留空` },
  subcategory: { type: "string", description: `子分類（以分類字典為準，例如 ${LOLITA_SUBCATEGORIES.join("/")}）` },
  brand: { type: "string" },
  style: { type: "string", description: `風格，可多個以「、」分隔：${STYLES.join("、")}` },
  primary_color: { type: "string", description: `主要顏色，最多 2 個以「、」分隔：${COLORS.join("、")}` },
  secondary_colors: { type: "array", items: { type: "string" } },
  pattern: { type: "string", description: "圖案／印花，如 十字架、蝴蝶結、格紋" },
  season: { type: "string", description: `可多個以「、」分隔：${SEASONS.join("、")}` },
  notes: { type: "string" },
  uncertain_fields: { type: "array", items: { type: "string" }, description: "AI 不確定的欄位名稱" },
  needs_review: { type: "boolean", description: "需要人工確認" },
  ai_note: { type: "string", description: "AI 判斷的理由或疑問" },
};

// 依 OpenAI Apps SDK 規格：download_url、file_id 必填；mime_type、file_name 可選
const fileObject = {
  type: "object",
  properties: {
    download_url: { type: "string" },
    file_id: { type: "string" },
    mime_type: { type: "string" },
    file_name: { type: "string" },
  },
  required: ["download_url", "file_id"],
};
const fileParam = { ...fileObject, description: "對話中的圖片檔案（ChatGPT 會自動填入 download_url 及 file_id）" };

const slotItem = {
  type: "object",
  properties: {
    client_key: { type: "string", description: "此批次內唯一，例如 01 或相片檔名；重複提交不會重複建立" },
    label: { type: "string", description: "顯示用名稱，例如「第1件 黑色JSK」" },
    file_name: { type: "string", description: "對應圖片的檔名，例如 01_black_jsk.png；上傳頁會按檔名自動配對" },
    image_type: { type: "string", enum: ["processed", "original"], default: "processed", description: "processed＝透明去背圖（PNG／WebP）" },
    expected_width: { type: "integer", description: "圖片實際寬度（像素）；提供後尺寸不符會被拒絕" },
    expected_height: { type: "integer", description: "圖片實際高度（像素）" },
    needs_review: { type: "boolean" },
    garment: { type: "object", properties: garmentProps },
  },
  required: ["client_key"],
};

const suggestionFields = {
  name: { type: "string", description: "描述性名稱，例如「黑色十字架印花 JSK」" },
  category: { type: "string", description: `主分類（以分類字典為準，預設：${CATEGORIES.join("、")}）` },
  subcategory: { type: "string", description: `子分類（以分類字典為準，例如 ${LOLITA_SUBCATEGORIES.join("、")}）` },
  style: { type: "string", description: `風格，可多個以「、」分隔：${STYLES.join("、")}` },
  primary_color: { type: "string", description: `主要顏色，最多 2 個以「、」分隔：${COLORS.join("、")}` },
  secondary_colors: { type: "array", items: { type: "string" } },
  pattern: { type: "string", description: "印花主題" },
  details: { type: "string", description: "裝飾細節，例如 蕾絲、蝴蝶結、珍珠扣" },
  season: { type: "string", description: `可多個以「、」分隔：${SEASONS.join("、")}` },
  is_full_outfit: { type: "boolean", description: "相片是否整套穿搭" },
  has_multiple_items: { type: "boolean", description: "相片是否包含多件獨立衣服" },
  needs_review: { type: "boolean" },
  uncertain_fields: { type: "array", items: { type: "string" } },
  ai_note: { type: "string", description: "判斷理由或疑問" },
  brand: { type: "string" },
  brand_confidence: { type: "string", enum: ["confirmed", "likely", "unconfirmed"] },
  official_name: { type: "string", description: "官方款式名稱" },
  series_name: { type: "string" },
  release_year: { type: "integer" },
  source_urls: { type: "array", items: { type: "string" }, description: "可驗證的來源連結" },
  source_type: { type: "string", description: "官網／Lolibrary／官方社交媒體／二手交易／其他" },
  brand_note: { type: "string" },
  brand_evidence_from_generated_image: { type: "boolean" },
  same_garment_as: { type: "string", description: "如果這張相與清單中另一件衣物是同一件衣服（例如一張透明去背圖、一張原相），填另一件的 garment_id；使用者會在 App 確認後才合併" },
};

const TOOLS = [
  {
    scope: "read",
    name: "list_pending_garments",
    title: "列出待整理衣物",
    description: "取得 App 上傳後等待 AI 辨認的衣物（含 version、目前資料、鎖定欄位及圖片資料）。分析前必須再用 get_garment_image 實際查看圖片。",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 30, default: 10 },
        garment_ids: { type: "array", items: { type: "string" }, description: "只取指定衣物" },
      },
    },
  },
  {
    scope: "read",
    name: "get_garment_image",
    title: "查看衣物圖片",
    description: "回傳圖片本身（image content），讓你實際查看像素。預設給約 1600px 的辨認用圖；size=original 給未經改動的原圖（較大，只限 4 MB 以下）。",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        garment_id: { type: "string" },
        image_id: { type: "string", description: "可選；不填就自動揀選" },
        size: { type: "string", enum: ["analysis", "original"], default: "analysis" },
      },
      required: ["garment_id"],
    },
  },
  {
    scope: "update",
    name: "claim_garments",
    title: "標記 AI 整理中",
    description: "把衣物標記為「AI 整理中」（30 分鐘租約，逾時自動退回）。可選用，避免兩個 AI 同時處理同一件。",
    inputSchema: { type: "object", properties: { garment_ids: { type: "array", items: { type: "string" } } }, required: ["garment_ids"] },
  },
  {
    scope: "update",
    name: "submit_ai_suggestion",
    title: "提交 AI 整理建議",
    description: "提交一件衣物的辨認結果。只會建立待使用者確認的建議，不會直接修改正式資料。同一 idempotency_key 重試不會重複建立。",
    inputSchema: {
      type: "object",
      properties: {
        garment_id: { type: "string" },
        base_version: { type: "integer", description: "list_pending_garments 給的 version" },
        idempotency_key: { type: "string" },
        image_id: { type: "string", description: "你實際查看的圖片" },
        vision_checked: { type: "boolean", description: "已實際查看圖片像素才可為 true" },
        outcome: { type: "string", enum: ["suggestion", "failed"], default: "suggestion" },
        failure_reason: { type: "string" },
        ...suggestionFields,
      },
      required: ["garment_id", "base_version", "idempotency_key", "vision_checked"],
    },
  },
  {
    name: "import_garment_files",
    title: "匯入對話中的圖片檔",
    description:
      "一次匯入最多 10 個對話中的圖片檔（openai/fileParams）。伺服器下載原檔 → 驗證 PNG／WebP、尺寸及透明通道 → 先寫 R2 → 成功後才建立衣物記錄。按 file_name 配對 items，否則按次序。失敗的項目會回傳上傳頁連結讓使用者補傳。",
    scope: "upload",
    _meta: { "openai/fileParams": ["files"] },
    inputSchema: {
      type: "object",
      properties: {
        files: { type: "array", maxItems: 10, items: fileObject, description: "對話中的圖片檔案" },
        items: { type: "array", maxItems: 10, items: slotItem },
        batch_id: { type: "string" },
        client_ref: { type: "string", description: "自訂批次識別碼，可跨對話續用" },
        source: { type: "string", description: "chatgpt 或 claude" },
        note: { type: "string" },
      },
      required: ["files"],
    },
  },
  {
    name: "create_upload_session",
    title: "建立批量上傳",
    description:
      "為最多 10 件衣物建立上傳槽，回傳 upload_page_url（使用者一次選取多張相，按檔名配對）及每件的 put_url（任何可連網的程式可用 HTTP PUT 上傳原始 PNG／WebP 二進位）。此時不會建立衣物記錄；圖片寫入 R2 成功後才建立。items 留空並提供 batch_id 可為未完成項目重新產生連結（重試）。",
    scope: "import",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", maxItems: 10, items: slotItem },
        batch_id: { type: "string", description: "續用或重試既有批次" },
        client_ref: { type: "string", description: "自訂批次識別碼，例如 2026-11-08-lolita-1" },
        source: { type: "string", description: "chatgpt 或 claude" },
        note: { type: "string" },
        minutes: { type: "integer", minimum: 5, maximum: 1440, description: "連結有效分鐘，預設 180" },
      },
    },
  },
  {
    name: "get_upload_session",
    title: "上傳進度",
    description: "讀取批次中每個上傳槽的狀態（pending／uploading／done／duplicate／failed）、實際解像度、透明通道及錯誤訊息。",
    scope: "read",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { batch_id: { type: "string" } }, required: ["batch_id"] },
  },
  {
    name: "list_taxonomy",
    title: "分類字典",
    description: "讀取使用者目前的分類字典：主分類及其子分類、屬性（例如袖長、裙長）及可選值、每個屬性適用的主分類。辨認衣物前先讀取，只使用字典內的名稱。",
    scope: "read",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_garments",
    title: "列出衣物",
    description: "搜尋或篩選衣櫃中的衣物。",
    scope: "read",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        category: { type: "string" },
        style: { type: "string" },
        color: { type: "string" },
        status: { type: "string", enum: ["active", "review", "archived", "all"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    name: "get_garment",
    title: "衣物詳情",
    description: "取得一件衣物的完整資料及圖片清單（含解像度及 R2 key）。",
    scope: "read",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { garment_id: { type: "string" } }, required: ["garment_id"] },
  },
  {
    name: "create_import_batch",
    title: "建立匯入批次",
    description: "建立新的匯入批次。若提供已用過的 client_ref，會回傳同一批次，方便跨對話繼續。",
    scope: "import",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "chatgpt 或 claude" },
        note: { type: "string" },
        client_ref: { type: "string", description: "自訂批次識別碼，例如 2026-11-08-lolita-1" },
      },
    },
  },
  {
    name: "add_garments",
    title: "加入衣物資料",
    description: "把已識別的衣物（或整套穿搭）加入批次。每項需要唯一的 client_key（例如相片編號）；重複提交同一 client_key 不會重複建立。",
    scope: "import",
    inputSchema: {
      type: "object",
      properties: {
        batch_id: { type: "string" },
        items: {
          type: "array",
          maxItems: 30,
          items: {
            type: "object",
            properties: {
              client_key: { type: "string" },
              kind: { type: "string", enum: ["garment", "outfit"] },
              label: { type: "string", description: "例如「第3張相」" },
              garment: { type: "object", properties: garmentProps },
              outfit: { type: "object", properties: { name: { type: "string" }, notes: { type: "string" }, style: { type: "string" } } },
              needs_review: { type: "boolean" },
            },
            required: ["client_key"],
          },
        },
      },
      required: ["batch_id", "items"],
    },
  },
  {
    name: "upload_garment_image",
    title: "上傳衣物圖片",
    description:
      "把圖片寫入私人 R2。提供 file（對話中的圖片檔案）、image_url（https 下載連結）或 image_base64 其中一項。去背圖用 image_type=processed（透明 PNG/WebP），原圖用 original。不要縮小圖片。",
    scope: "upload",
    _meta: { "openai/fileParams": ["file"] },
    inputSchema: {
      type: "object",
      properties: {
        garment_id: { type: "string" },
        outfit_id: { type: "string" },
        job_id: { type: "string", description: "add_garments 回傳的 job_id，可代替 garment_id" },
        image_type: { type: "string", enum: ["processed", "original"], default: "processed" },
        file: fileParam,
        image_url: { type: "string" },
        image_base64: { type: "string", description: "備用：Base64 或 data URL（只作傳輸，伺服器會轉為二進位存 R2）" },
        is_primary: { type: "boolean" },
      },
    },
  },
  {
    name: "create_upload_link",
    title: "產生上傳連結",
    description: "當你無法把圖片檔案內容傳給工具時使用：產生短效上傳連結，使用者在手機開啟後按次序選相上傳。",
    scope: "import",
    inputSchema: {
      type: "object",
      properties: {
        batch_id: { type: "string", description: "預設包括此批次所有未有圖片的項目" },
        garment_ids: { type: "array", items: { type: "string" } },
        image_type: { type: "string", enum: ["processed", "original"] },
        minutes: { type: "integer", minimum: 5, maximum: 1440 },
      },
    },
  },
  {
    name: "update_garment",
    title: "修改衣物",
    description: "修改衣物資料。設 confirm=true 代表使用者已確認，清除不確定標記。",
    scope: "update",
    inputSchema: {
      type: "object",
      properties: { garment_id: { type: "string" }, ...garmentProps, is_favorite: { type: "boolean" }, confirm: { type: "boolean" } },
      required: ["garment_id"],
    },
  },
  {
    name: "finalize_import_batch",
    title: "完成批次",
    description: "完成批次。仍未收到圖片的項目會標記為失敗，可之後重試。",
    scope: "import",
    inputSchema: { type: "object", properties: { batch_id: { type: "string" } }, required: ["batch_id"] },
  },
  {
    name: "get_import_status",
    title: "批次進度",
    description: "讀取批次及每個項目的狀態，用來核實是否成功入庫。",
    scope: "read",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { batch_id: { type: "string" } }, required: ["batch_id"] },
  },
] as const;

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

function rpcResult(id: Rpc["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: Rpc["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export async function handleMcp(req: Request, env: Env, url: URL): Promise<Response> {
  const pathToken = url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]{20,200})\/?$/)?.[1];
  const header = req.headers.get("authorization");
  const raw = pathToken || (header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "");
  const actor = raw ? await authenticateToken(env, raw) : null;
  if (!actor) {
    return json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="ai-wardrobe"' });
  }
  if (req.method === "GET" || req.method === "DELETE") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  if (req.method !== "POST") return new Response(null, { status: 405 });

  const limit = Math.ceil(maxUploadBytes(env) * 1.4) + 1_000_000; // 容許 base64 膨脹
  const len = Number(req.headers.get("content-length") || "0");
  if (len > limit) return json(rpcError(null, -32600, "請求內容過大"), 413);
  let body: Rpc | Rpc[];
  try {
    body = JSON.parse(await req.text());
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  const list = Array.isArray(body) ? body : [body];
  const responses: unknown[] = [];
  for (const msg of list) {
    const r = await handleRpc(env, actor, msg, url.origin);
    if (r) responses.push(r);
  }
  if (!responses.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? responses : responses[0]);
}

async function handleRpc(env: Env, actor: Actor, msg: Rpc, origin: string) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid Request");
  const isNotification = msg.id === undefined;
  try {
    switch (msg.method) {
      case "initialize": {
        const requested = String(msg.params?.protocolVersion || "");
        return rpcResult(msg.id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "ai-wardrobe", title: "AI Wardrobe 電子衣櫃", version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return rpcResult(msg.id, {});
      case "tools/list":
        return rpcResult(msg.id, {
          tools: TOOLS.filter((t) => actor.scopes.has(t.scope)).map(({ scope, ...t }) => {
            void scope;
            return t;
          }),
        });
      case "tools/call": {
        const name = String(msg.params?.name || "");
        const args = (msg.params?.arguments || {}) as Record<string, unknown>;
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return rpcError(msg.id, -32602, `未知工具：${name}`);
        try {
          requireScope(actor, tool.scope);
          await meterCall(env, actor);
          const data = await callTool(env, actor, name, args, origin);
          if (Array.isArray(data.__content)) {
            const { __content, ...meta } = data;
            return rpcResult(msg.id, { content: [...(__content as unknown[]), { type: "text", text: JSON.stringify(meta) }], structuredContent: meta });
          }
          return rpcResult(msg.id, { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
        } catch (err) {
          const message = err instanceof HttpError ? `${err.message}（${err.code}）` : "工具執行失敗";
          if (!(err instanceof HttpError)) console.error("tool error", name, err);
          return rpcResult(msg.id, { content: [{ type: "text", text: message }], isError: true });
        }
      }
      default:
        if (isNotification) return null;
        if (msg.method.startsWith("notifications/")) return null;
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    console.error("rpc error", err);
    return isNotification ? null : rpcError(msg.id, -32603, "Internal error");
  }
}

async function callTool(env: Env, actor: Actor, name: string, a: Record<string, unknown>, origin: string): Promise<Record<string, unknown>> {
  const need = (k: string) => {
    const v = a[k];
    if (v === undefined || v === null || v === "") throw new HttpError(400, "missing_arg", `缺少參數 ${k}`);
    return String(v);
  };
  switch (name) {
    case "import_garment_files": {
      const metered = async (url: string, max: number) => {
        const b = await downloadHttps(url, max);
        await meterCall(env, actor, b.byteLength);
        return b;
      };
      return await importGarmentFiles(env, actor, origin, { ...a, source: a.source ?? actor.label }, metered);
    }
    case "create_upload_session": {
      const { _token, ...out } = await createUploadSession(env, actor, origin, { ...a, source: a.source ?? actor.label });
      void _token;
      return {
        ...out,
        next_step: out.upload_page_url
          ? "把 upload_page_url 交給使用者（可一次選取全部圖片，按檔名配對）；可連網的程式亦可對每個 put_url 以 HTTP PUT 上傳原始 PNG／WebP。完成後用 get_upload_session 核實。"
          : "全部項目已完成，毋須上傳。",
      };
    }
    case "get_upload_session":
      return await getUploadSession(env, need("batch_id"));
    case "list_pending_garments": {
      const ids = Array.isArray(a.garment_ids) ? (a.garment_ids as unknown[]).map(String) : undefined;
      const q = await aiQueue(env, origin, { limit: Number(a.limit) || 10, garment_ids: ids });
      return {
        ...q,
        next_step: q.count
          ? "逐件呼叫 get_garment_image 查看圖片，分析後用 submit_ai_suggestion 提交（附 base_version 及 idempotency_key）。"
          : "目前沒有待整理衣物。",
      };
    }
    case "get_garment_image":
      return await mcpImage(env, need("garment_id"), a.image_id ? String(a.image_id) : null, a.size === "original" ? "original" : "analysis");
    case "claim_garments":
      return await claimGarments(env, actor, (a.garment_ids as string[]) ?? [], actor.label);
    case "submit_ai_suggestion": {
      const { garment_id, base_version, idempotency_key, image_id, vision_checked, outcome, failure_reason, source, ...fields } = a;
      return await submitSuggestion(env, actor, {
        garment_id, base_version, idempotency_key, image_id, vision_checked, outcome, failure_reason,
        source: source ?? actor.label, fields,
      });
    }
    case "list_taxonomy": {
      const t = await getTaxonomy(env, false);
      return {
        categories: t.categories.map((c) => ({ name: c.name, subcategories: c.subs.map((x) => x.name) })),
        attributes: t.attributes.map((x) => ({
          id: x.id, name: x.name, multi: x.multi, max_select: x.max_select,
          only_for_categories: x.show_for?.map((id) => t.categories.find((c) => c.id === id)?.name).filter(Boolean) ?? null,
          options: x.options.map((o) => o.name),
        })),
        note: "style、primary_color、secondary_colors、season 對應衣物原有欄位；其他屬性目前只可由使用者在 App 填寫。",
      };
    }
    case "list_garments": {
      const p = new URLSearchParams();
      for (const k of ["q", "category", "style", "color", "status", "limit", "offset"]) if (a[k] !== undefined) p.set(k, String(a[k]));
      if (!a.limit) p.set("limit", "50");
      const res = await listGarments(env, p);
      return {
        garments: res.garments.map((g) => ({
          id: g.id, name: g.name, category: g.category, subcategory: g.subcategory, style: g.style, brand: g.brand,
          primary_color: g.primary_color, status: g.status, image_count: g.image_count, uncertain_fields: g.uncertain_fields,
        })),
        next_offset: res.next_offset,
      };
    }
    case "get_garment":
      return await getGarment(env, need("garment_id"));
    case "create_import_batch": {
      const { batch, resumed } = await createBatch(env, actor, { source: a.source ?? actor.label, note: a.note, client_ref: a.client_ref });
      return { batch, resumed };
    }
    case "add_garments": {
      const results = await addItems(env, actor, need("batch_id"), a.items as never);
      return { results, next_step: "請用 upload_garment_image 為每個 garment_id／job_id 上傳圖片；無法傳圖時用 create_upload_link。" };
    }
    case "upload_garment_image":
      return await mcpUpload(env, actor, a);
    case "create_upload_link":
      return await createUploadLink(env, actor, origin, a);
    case "update_garment": {
      const id = need("garment_id");
      const { garment_id, ...rest } = a;
      void garment_id;
      const r = await updateGarment(env, actor, id, rest);
      return { ...(await getGarment(env, id)), skipped_locked: r.skipped_locked };
    }
    case "finalize_import_batch":
      return await finalizeBatch(env, actor, need("batch_id"));
    case "get_import_status":
      return await getBatch(env, need("batch_id"));
  }
  throw new HttpError(400, "unknown_tool", "未知工具");
}

async function mcpUpload(env: Env, actor: Actor, a: Record<string, unknown>) {
  let owner: Owner = "garment";
  let ownerId = a.garment_id ? String(a.garment_id) : "";
  const jobId = a.job_id ? String(a.job_id) : null;
  if (a.outfit_id) {
    owner = "outfit";
    ownerId = String(a.outfit_id);
  }
  if (jobId && !ownerId) {
    const job = await env.DB.prepare("SELECT garment_id, outfit_id FROM import_jobs WHERE id = ?").bind(jobId).first<{ garment_id: string | null; outfit_id: string | null }>();
    if (!job) throw new HttpError(404, "job_not_found", "找不到 job_id");
    if (job.garment_id) ownerId = job.garment_id;
    else if (job.outfit_id) {
      owner = "outfit";
      ownerId = job.outfit_id;
    }
  }
  if (!ownerId) throw new HttpError(400, "missing_target", "需要 garment_id、outfit_id 或 job_id");
  const imageType = (a.image_type === "original" ? "original" : "processed") as ImageType;

  let bytes: Uint8Array;
  try {
    bytes = await obtainBytes(env, a);
  } catch (err) {
    if (jobId && err instanceof HttpError) await failJob(env, jobId, err.message);
    throw err;
  }
  await meterCall(env, actor, bytes.byteLength);
  try {
    const img = await storeImage(env, { owner, ownerId, imageType, bytes, isPrimary: Boolean(a.is_primary), actor });
    await onImageStored(env, img, jobId);
    return { ...img, view_url: `/api/images/${img.id}` };
  } catch (err) {
    if (jobId && err instanceof HttpError) await failJob(env, jobId, err.message);
    throw err;
  }
}

async function obtainBytes(env: Env, a: Record<string, unknown>): Promise<Uint8Array> {
  const max = maxUploadBytes(env);
  const file = a.file as { download_url?: string } | undefined;
  const urlStr = file?.download_url || (typeof a.image_url === "string" ? a.image_url : "");
  if (urlStr) {
    if (urlStr.startsWith("data:")) return decodeBase64(urlStr, max);
    return downloadHttps(urlStr, max);
  }
  if (typeof a.image_base64 === "string" && a.image_base64) return decodeBase64(a.image_base64, max);
  throw new HttpError(400, "no_image", "請提供 file、image_url 或 image_base64；如無法傳送圖片，請改用 create_upload_link");
}

function decodeBase64(input: string, max: number): Uint8Array {
  const b64 = input.replace(/^data:[^;,]+;base64,/, "").replace(/\s+/g, "");
  if (b64.length * 0.75 > max) throw new HttpError(413, "file_too_large", "圖片超過上傳上限");
  let bin: string;
  try {
    bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new HttpError(400, "bad_base64", "Base64 格式錯誤");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const MCP_IMAGE_MAX = 4 * 1024 * 1024;

/** 把圖片以 MCP image content 回傳，讓 AI 真正看到像素 */
async function mcpImage(env: Env, garmentId: string, imageId: string | null, size: "analysis" | "original"): Promise<Record<string, unknown>> {
  const { results } = await env.DB.prepare(
    "SELECT id, image_type, variant, r2_key, mime_type, width, height, file_size FROM garment_images WHERE garment_id = ? ORDER BY created_at",
  )
    .bind(garmentId)
    .all<{ id: string; image_type: string; variant: string | null; r2_key: string; mime_type: string; width: number; height: number; file_size: number }>();
  if (!results.length) throw new HttpError(404, "no_image", "這件衣物沒有圖片");
  const viewable = (i: (typeof results)[number]) => /^image\/(jpeg|png|webp)$/.test(i.mime_type) && i.file_size <= MCP_IMAGE_MAX;
  let img = imageId ? results.find((i) => i.id === imageId) : undefined;
  if (imageId && !img) throw new HttpError(404, "image_not_found", "image_id 不屬於這件衣物");
  if (!img) {
    const order =
      size === "original"
        ? [(i: (typeof results)[number]) => i.image_type === "original" && !i.variant, (i: (typeof results)[number]) => i.variant === "preview", (i: (typeof results)[number]) => i.image_type === "processed", (i: (typeof results)[number]) => i.variant === "analysis"]
        : [(i: (typeof results)[number]) => i.variant === "analysis", (i: (typeof results)[number]) => i.variant === "preview", (i: (typeof results)[number]) => i.image_type === "original" && !i.variant, (i: (typeof results)[number]) => i.image_type === "processed", (i: (typeof results)[number]) => i.image_type === "thumbnail"];
    for (const f of order) {
      img = results.find((i) => f(i) && viewable(i));
      if (img) break;
    }
  }
  if (!img || !viewable(img)) throw new HttpError(413, "image_not_viewable", "沒有可直接查看的圖片（HEIC 或超過 4 MB）；請改用 size=analysis");
  const obj = await env.IMAGES.get(img.r2_key);
  if (!obj) throw new HttpError(404, "object_missing", "R2 找不到圖片檔案");
  const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {
    __content: [{ type: "image", data: btoa(bin), mimeType: img.mime_type }],
    garment_id: garmentId,
    image_id: img.id,
    image_type: img.image_type,
    variant: img.variant,
    width: img.width,
    height: img.height,
    note: img.variant === "analysis" ? "約 1600px 縮小版（由原圖縮小，未經 AI 改動）" : img.image_type === "processed" ? "去背圖：品牌辨認請以原圖為準" : "原圖",
  };
}
