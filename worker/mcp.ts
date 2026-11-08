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
import { Actor, Env, HttpError, json, requireScope } from "./util";

const SERVER_VERSION = "0.1.0";
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `你正在操作使用者的私人「AI Wardrobe 智能電子衣櫃」。
流程：create_import_batch（可用 client_ref 跨對話續做同一批）→ add_garments（每件衣物一個 client_key）→ upload_garment_image（每件上傳去背圖 processed，可另傳原圖 original）→ get_import_status 核實 → finalize_import_batch。
如果無法把圖片檔案內容傳給工具，請呼叫 create_upload_link，把連結交給使用者，由使用者在手機選相上傳。
分類規則：category 只可用 ${CATEGORIES.join("、")}；Lolita 子類 ${LOLITA_SUBCATEGORIES.join("、")}；style 只可用 ${STYLES.join("、")}。
不確定的欄位請留空並列入 uncertain_fields，或設 needs_review=true，不要猜測。
若相片是真人整套穿搭，請用 kind="outfit" 保存為穿搭待覆核，不要假裝已拆成單品。
不要把圖片縮小；請上傳最高解像度的版本。`;

const garmentProps = {
  name: { type: "string", description: "衣物名稱（可含系列名）" },
  category: { type: "string", enum: [...CATEGORIES], description: "主類別；不確定請留空" },
  subcategory: { type: "string", description: `Lolita 子類（${LOLITA_SUBCATEGORIES.join("/")}）或其他子類` },
  brand: { type: "string" },
  style: { type: "string", enum: [...STYLES] },
  primary_color: { type: "string", description: `主色，建議使用：${COLORS.join("、")}` },
  secondary_colors: { type: "array", items: { type: "string" } },
  pattern: { type: "string", description: "圖案／印花，如 十字架、蝴蝶結、格紋" },
  season: { type: "string", description: SEASONS.join("、") },
  notes: { type: "string" },
  uncertain_fields: { type: "array", items: { type: "string" }, description: "AI 不確定的欄位名稱" },
  needs_review: { type: "boolean", description: "需要人工確認" },
  ai_note: { type: "string", description: "AI 判斷的理由或疑問" },
};

const fileParam = {
  type: "object",
  description: "對話中使用者上傳或 AI 產生的圖片檔案",
  properties: {
    download_url: { type: "string" },
    file_id: { type: "string" },
    mime_type: { type: "string" },
  },
};

const TOOLS = [
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
      await updateGarment(env, actor, id, rest);
      return await getGarment(env, id);
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
    let u: URL;
    try {
      u = new URL(urlStr);
    } catch {
      throw new HttpError(400, "bad_url", "圖片網址格式錯誤");
    }
    if (u.protocol !== "https:") throw new HttpError(400, "bad_url", "只接受 https 圖片網址");
    const res = await fetch(u.toString(), { redirect: "follow" });
    if (!res.ok || !res.body) throw new HttpError(502, "download_failed", `下載圖片失敗（HTTP ${res.status}）`);
    const declared = Number(res.headers.get("content-length") || "0");
    if (declared > max) throw new HttpError(413, "file_too_large", "圖片超過上傳上限");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new HttpError(413, "file_too_large", "圖片超過上傳上限");
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
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
