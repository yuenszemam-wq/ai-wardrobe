import { authenticate, checkCsrf, handleAuth, handleTokens, meterCall } from "./auth";
import { createGarment, deleteGarment, getGarment, listGarments, stats, updateGarment } from "./garments";
import { cleanupOrphans, deleteImage, ImageType, Owner, readUploadBody, serveImage, setPrimary, storeImage } from "./images";
import { actOnJob, addItems, createBatch, createUploadLink, failJob, finalizeBatch, getBatch, listBatches, loadTicket, onImageStored } from "./imports";
import { handleMcp } from "./mcp";
import { createUploadSession, getUploadSession, handleSlotUpload } from "./uploads";
import { processStaging } from "./staging";
import { createOutfit, deleteOutfit, getOutfit, listOutfits, updateOutfit } from "./outfits";
import { Actor, Env, HttpError, errorResponse, json, nowIso, readJson, requireScope, requireSession } from "./util";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const started = Date.now();
    try {
      let res: Response;
      if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) res = await handleMcp(req, env, url);
      else if (url.pathname.startsWith("/api/")) res = await handleApi(req, env, url);
      else return env.ASSETS.fetch(req);
      logRequest(req, url, res.status, started);
      return withSecurityHeaders(res);
    } catch (err) {
      const res = errorResponse(err);
      logRequest(req, url, res.status, started, err);
      return withSecurityHeaders(res);
    }
  },
  // 每分鐘處理 D1 暫存匯入（import_staging）
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      processStaging(env).then((r) => {
        if (r.length) console.log(JSON.stringify({ staging: r }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;

function logRequest(req: Request, url: URL, status: number, started: number, err?: unknown) {
  // 不記錄 MCP 網址中的權杖
  const path = url.pathname.startsWith("/mcp/") ? "/mcp/***" : url.pathname.replace(/^\/api\/(public\/upload|upload)\/[^/]+/, "/api/$1/***");
  const line = { m: req.method, p: path, s: status, ms: Date.now() - started };
  if (status >= 500) console.error(JSON.stringify({ ...line, err: String(err) }));
  else console.log(JSON.stringify(line));
}

function withSecurityHeaders(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "no-referrer");
  h.set("x-frame-options", "DENY");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method;

  if (path.startsWith("/api/auth/")) return handleAuth(req, env, path);
  if (path === "/api/health") return json({ ok: true, time: nowIso() });

  // 公開的短效上傳連結（不需登入，但需有效連結）
  const pub = path.match(/^\/api\/public\/upload\/([A-Za-z0-9_-]{20,80})(?:\/(\d+))?$/);
  if (pub) return handlePublicUpload(req, env, pub[1], pub[2]);
  // 批量二進位上傳槽（R2 先寫、D1 後寫）
  const slotUp = path.match(/^\/api\/upload\/([A-Za-z0-9_-]{20,80})(?:\/(slt_[a-z2-7]+)(?:\/(thumbnail))?)?$/);
  if (slotUp) return handleSlotUpload(req, env, slotUp[1], slotUp[2], slotUp[3]);

  const actor = await authenticate(req, env);
  if (!actor) throw new HttpError(401, "unauthorized", "請先登入");
  checkCsrf(req, actor);
  await meterCall(env, actor);

  if (path.startsWith("/api/tokens")) return handleTokens(req, env, actor, path);

  if (path === "/api/stats" && method === "GET") {
    requireScope(actor, "read");
    return stats(env);
  }

  // ───── 衣物 ─────
  if (path === "/api/garments") {
    if (method === "GET") {
      requireScope(actor, "read");
      return json(await listGarments(env, url.searchParams));
    }
    if (method === "POST") {
      requireScope(actor, "import");
      const body = await readJson(req);
      const created = await createGarment(env, actor, body, { source: actor.kind === "session" ? "manual" : actor.label, clientKey: (body.client_key as string) || null });
      return json(await getGarment(env, created.id), created.deduplicated ? 200 : 201);
    }
  }
  let m = path.match(/^\/api\/garments\/([\w-]+)$/);
  if (m) {
    const id = m[1];
    if (method === "GET") {
      requireScope(actor, "read");
      return json(await getGarment(env, id));
    }
    if (method === "PATCH") {
      requireScope(actor, "update");
      await updateGarment(env, actor, id, await readJson(req));
      return json(await getGarment(env, id));
    }
    if (method === "DELETE") {
      requireSession(actor);
      await deleteGarment(env, actor, id);
      return json({ ok: true });
    }
  }

  // ───── 圖片 ─────
  if (path === "/api/images/upload" && (method === "POST" || method === "PUT")) {
    requireScope(actor, "upload");
    const { bytes, fields } = await readUploadBody(req, env);
    await meterCall(env, actor, bytes.byteLength);
    let owner: Owner = "garment";
    let ownerId = fields.garment_id || "";
    const jobId = fields.job_id || null;
    if (fields.outfit_id) {
      owner = "outfit";
      ownerId = fields.outfit_id;
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
    try {
      const img = await storeImage(env, {
        owner,
        ownerId,
        imageType: (fields.image_type || "original") as ImageType,
        bytes,
        isPrimary: fields.is_primary === "1" || fields.is_primary === "true",
        derivedFrom: fields.derived_from || null,
        actor,
      });
      await onImageStored(env, img, jobId);
      return json(img, img.deduplicated ? 200 : 201);
    } catch (err) {
      if (jobId && err instanceof HttpError) await failJob(env, jobId, err.message);
      throw err;
    }
  }
  m = path.match(/^\/api\/images\/([\w-]+)$/);
  if (m) {
    if (method === "GET") {
      requireScope(actor, "read");
      return serveImage(req, env, m[1]);
    }
    if (method === "DELETE") {
      requireSession(actor);
      return deleteImage(env, actor, m[1]);
    }
  }
  m = path.match(/^\/api\/images\/([\w-]+)\/primary$/);
  if (m && method === "POST") {
    requireScope(actor, "update");
    return setPrimary(env, m[1]);
  }

  // ───── 匯入 ─────
  if (path === "/api/import/batches") {
    if (method === "GET") {
      requireScope(actor, "read");
      return json({ batches: await listBatches(env, Number(url.searchParams.get("limit")) || 30) });
    }
    if (method === "POST") {
      requireScope(actor, "import");
      return json(await createBatch(env, actor, await readJson(req)), 201);
    }
  }
  m = path.match(/^\/api\/import\/batches\/([\w-]+)(?:\/(items|finalize|upload-link))?$/);
  if (m) {
    const [, id, sub] = m;
    if (!sub && method === "GET") {
      requireScope(actor, "read");
      return json(await getBatch(env, id));
    }
    if (sub === "items" && method === "POST") {
      requireScope(actor, "import");
      const body = await readJson<{ items?: unknown[] }>(req);
      return json({ results: await addItems(env, actor, id, (body.items ?? []) as never) });
    }
    if (sub === "finalize" && method === "POST") {
      requireScope(actor, "import");
      return json(await finalizeBatch(env, actor, id));
    }
    if (sub === "upload-link" && method === "POST") {
      requireScope(actor, "import");
      const body = await readJson(req);
      return json(await createUploadLink(env, actor, url.origin, { ...body, batch_id: id }));
    }
  }
  m = path.match(/^\/api\/import\/jobs\/([\w-]+)$/);
  if (m && method === "POST") {
    requireScope(actor, "update");
    const body = await readJson<{ action?: string }>(req);
    if (body.action === "reject") requireSession(actor);
    return json(await actOnJob(env, actor, m[1], String(body.action || "")));
  }
  if (path === "/api/upload-sessions" && method === "POST") {
    requireScope(actor, "import");
    const { _token, ...out } = await createUploadSession(env, actor, url.origin, await readJson(req));
    void _token;
    return json(out, 201);
  }
  m = path.match(/^\/api\/upload-sessions\/([\w-]+)$/);
  if (m && method === "GET") {
    requireScope(actor, "read");
    return json(await getUploadSession(env, m[1]));
  }
  if (path === "/api/upload-links" && method === "POST") {
    requireScope(actor, "import");
    return json(await createUploadLink(env, actor, url.origin, await readJson(req)));
  }

  // ───── 穿搭 ─────
  if (path === "/api/outfits") {
    if (method === "GET") {
      requireScope(actor, "read");
      return json({ outfits: await listOutfits(env, url.searchParams) });
    }
    if (method === "POST") {
      requireScope(actor, "update");
      return json(await createOutfit(env, actor, await readJson(req)), 201);
    }
  }
  m = path.match(/^\/api\/outfits\/([\w-]+)$/);
  if (m) {
    if (method === "GET") {
      requireScope(actor, "read");
      return json(await getOutfit(env, m[1]));
    }
    if (method === "PATCH") {
      requireScope(actor, "update");
      return json(await updateOutfit(env, actor, m[1], await readJson(req)));
    }
    if (method === "DELETE") {
      requireSession(actor);
      await deleteOutfit(env, actor, m[1]);
      return json({ ok: true });
    }
  }

  // ───── 維護 ─────
  if (path === "/api/maintenance/orphans" && method === "POST") {
    requireSession(actor);
    const body = await readJson<{ delete?: boolean }>(req);
    return cleanupOrphans(env, actor, Boolean(body.delete));
  }
  if (path === "/api/staging/process" && method === "POST") {
    requireSession(actor);
    return json({ processed: await processStaging(env) });
  }
  if (path === "/api/staging" && method === "GET") {
    requireSession(actor);
    const { results } = await env.DB.prepare(
      `SELECT client_ref, client_key, MAX(part_count) AS part_count, COUNT(*) AS parts, MIN(status) AS status, MAX(error_message) AS error,
         MAX(garment_id) AS garment_id, MIN(created_at) AS created_at, MAX(processed_at) AS processed_at
       FROM import_staging GROUP BY client_ref, client_key ORDER BY created_at DESC LIMIT 50`,
    ).all();
    return json({ staging: results });
  }
  if (path === "/api/usage" && method === "GET") {
    requireSession(actor);
    const { results } = await env.DB.prepare(
      `SELECT u.day, u.actor, u.calls, u.upload_bytes, t.name FROM usage_daily u LEFT JOIN api_tokens t ON t.id = u.actor
       ORDER BY u.day DESC LIMIT 60`,
    ).all();
    return json({ usage: results });
  }

  throw new HttpError(404, "not_found", "找不到此 API");
}

async function handlePublicUpload(req: Request, env: Env, token: string, indexStr?: string): Promise<Response> {
  const ticket = await loadTicket(env, token);
  if (!indexStr && req.method === "GET") {
    const targets = [];
    for (let i = 0; i < ticket.targets.length; i++) {
      const t = ticket.targets[i];
      const done = t.garment_id
        ? await env.DB.prepare("SELECT COUNT(*) AS n FROM garment_images WHERE garment_id = ? AND image_type = ?").bind(t.garment_id, t.image_type).first<{ n: number }>()
        : await env.DB.prepare("SELECT COUNT(*) AS n FROM outfit_images WHERE outfit_id = ? AND image_type = ?").bind(t.outfit_id, t.image_type).first<{ n: number }>();
      targets.push({ index: i, label: t.label, image_type: t.image_type, uploaded: (done?.n ?? 0) > 0 });
    }
    return json({ expires_at: ticket.expires_at, max_files: ticket.max_files, used_files: ticket.used_files, targets });
  }
  if (indexStr !== undefined && (req.method === "PUT" || req.method === "POST")) {
    if (req.headers.get("x-requested-with") !== "ai-wardrobe") throw new HttpError(403, "csrf", "請求來源驗證失敗");
    const t = ticket.targets[Number(indexStr)];
    if (!t) throw new HttpError(404, "bad_index", "沒有這個上傳位置");
    if (ticket.used_files >= ticket.max_files) throw new HttpError(429, "link_used_up", "此連結的上傳次數已用完");
    const { bytes, fields } = await readUploadBody(req, env);
    const actor: Actor = { kind: "ticket", id: ticket.token_hash.slice(0, 12), scopes: new Set(["upload"]), label: "upload-link" };
    const owner: Owner = t.garment_id ? "garment" : "outfit";
    const ownerId = (t.garment_id || t.outfit_id)!;
    // 縮圖由瀏覽器產生，與主圖分開存放
    const imageType: ImageType = fields.image_type === "thumbnail" ? "thumbnail" : t.image_type;
    const img = await storeImage(env, { owner, ownerId, imageType, bytes, derivedFrom: fields.derived_from || null, actor });
    if (!img.deduplicated) {
      await env.DB.prepare("UPDATE upload_tickets SET used_files = used_files + 1 WHERE token_hash = ?").bind(ticket.token_hash).run();
    }
    await onImageStored(env, img, null);
    return json(img, img.deduplicated ? 200 : 201);
  }
  throw new HttpError(405, "method_not_allowed", "不支援此方法");
}
