export interface GarmentImage {
  id: string;
  image_type: "original" | "processed" | "thumbnail";
  mime_type: string;
  width: number;
  height: number;
  file_size: number;
  has_alpha: boolean;
  is_primary: boolean;
  derived_from: string | null;
  r2_key: string;
  url: string;
  created_at: string;
  variant?: "preview" | "analysis" | null;
  sha256?: string;
}

export type AiStatus = "pending_ai" | "ai_processing" | "pending_review" | "done" | "failed" | "needs_rework";

export const AI_STATUS_LABEL: Record<AiStatus, string> = {
  pending_ai: "待 AI 辨認",
  ai_processing: "AI 整理中",
  pending_review: "待人工確認",
  done: "已完成",
  failed: "辨認失敗",
  needs_rework: "需要重新處理",
};

export const BRAND_CONFIDENCE_LABEL: Record<string, string> = {
  confirmed: "已確認",
  likely: "高度可能",
  unconfirmed: "未確認",
};

export interface AiNormalized {
  name: string | null;
  category: string | null;
  subcategory: string | null;
  style: string | null;
  primary_color: string | null;
  secondary_colors: string[] | null;
  pattern: string | null;
  season: string | null;
  details: string | null;
  is_full_outfit: boolean | null;
  has_multiple_items: boolean | null;
  needs_review: boolean;
  uncertain_fields: string[];
  ai_note: string | null;
  brand: string | null;
  brand_candidate: string | null;
  brand_confidence: "confirmed" | "likely" | "unconfirmed";
  official_name: string | null;
  series_name: string | null;
  release_year: number | null;
  source_urls: string[];
  source_type: string | null;
  brand_note: string | null;
  brand_evidence_from_generated_image: boolean;
  warnings?: string[];
}

export interface AiSuggestion {
  suggestion_id: number;
  status: string;
  source: string;
  base_version: number;
  image_id: string | null;
  vision_checked: boolean;
  normalized: AiNormalized | null;
  error_message: string | null;
  created_at: string;
}

export interface ReviewItem extends Garment {
  has_processed: boolean;
  suggestion: AiSuggestion | null;
}

export interface Garment {
  id: string;
  name: string;
  category: string | null;
  subcategory: string | null;
  brand: string | null;
  style: string | null;
  primary_color: string | null;
  secondary_colors: string[];
  pattern: string | null;
  season: string | null;
  notes: string | null;
  attributes?: Record<string, string | string[]>;
  status: "active" | "review" | "archived";
  is_favorite: boolean;
  ai_status?: AiStatus | null;
  display_no?: number | null;
  name_is_placeholder?: boolean;
  locked_fields?: string[];
  version?: number;
  ai_error?: string | null;
  has_processed?: number | boolean;
  uncertain_fields: string[];
  ai_note: string | null;
  source: string | null;
  primary_image_id: string | null;
  thumb_image_id: string | null;
  image_count: number;
  created_at: string;
  updated_at: string;
  images?: GarmentImage[];
  outfits?: { id: string; name: string }[];
}

export interface Batch {
  id: string;
  source: string;
  note: string | null;
  total_images: number;
  processed_count: number;
  success_count: number;
  review_count: number;
  failed_count: number;
  status: "open" | "finalized";
  created_at: string;
}

export interface Job {
  id: string;
  batch_id: string;
  client_key: string;
  kind: "garment" | "outfit";
  garment_id: string | null;
  outfit_id: string | null;
  label: string | null;
  status: "awaiting_image" | "done" | "review" | "failed";
  error_message: string | null;
  retry_count: number;
  garment_name: string | null;
  outfit_name: string | null;
  preview_image_id: string | null;
  uncertain_fields: string | null;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("x-requested-with", "ai-wardrobe");
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, headers, body, credentials: "same-origin" });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string } })?.error;
    if (res.status === 401 && !path.startsWith("/api/auth/")) window.dispatchEvent(new Event("aw:unauthorized"));
    throw new ApiError(res.status, err?.code || "http_error", err?.message || `請求失敗（${res.status}）`);
  }
  return data as T;
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export const imageUrl = (id: string | null | undefined) => (id ? `/api/images/${id}` : "");

/** 以二進位上傳（multipart），支援進度回報 */
export function uploadImage(
  url: string,
  fields: Record<string, string>,
  file: Blob,
  filename: string,
  onProgress?: (ratio: number) => void,
  method: "POST" | "PUT" = "POST",
): Promise<{ id: string; deduplicated: boolean; warnings: string[]; width: number; height: number; is_primary: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-requested-with", "ai-wardrobe");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const data = safeJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error?.code || "upload_failed", data?.error?.message || `上傳失敗（${xhr.status}）`));
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "網絡中斷，請重試"));
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set("file", file, filename);
    xhr.send(fd);
  });
}

/** 不把 UUID 當名稱顯示 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function displayName(g: Pick<Garment, "name" | "display_no">): string {
  if (!g.name || UUID_RE.test(g.name.trim())) return g.display_no ? `待整理衣物 ${String(g.display_no).padStart(3, "0")}` : "待整理衣物";
  return g.name;
}

export interface IntakeResult {
  garment_id: string;
  name: string;
  display_no: number | null;
  duplicate: boolean;
  verified: boolean;
  image: { id: string; width: number; height: number; file_size: number; sha256: string; mime_type: string; image_type: string };
  cutout_id?: string | null; // 自動去背圖已由伺服器保存時才有
  warnings: string[];
}

/** 批量上傳：一張相＝一件待整理衣物（multipart，附進度） */
export function intakeUpload(
  parts: { file: Blob; filename: string; sha256: string; preview?: Blob | null; thumbnail?: Blob | null; analysis?: Blob | null; cutout?: Blob | null },
  onProgress?: (ratio: number) => void,
  signal?: AbortSignal,
): Promise<IntakeResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/intake");
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-requested-with", "ai-wardrobe");
    xhr.timeout = 10 * 60_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const data = safeJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        if (xhr.status === 401) window.dispatchEvent(new Event("aw:unauthorized"));
        reject(new ApiError(xhr.status, data?.error?.code || "upload_failed", data?.error?.message || `上傳失敗（${xhr.status}）`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "網絡中斷，請重試"));
    xhr.ontimeout = () => reject(new ApiError(0, "timeout", "上傳逾時，請重試"));
    xhr.onabort = () => reject(new ApiError(0, "aborted", "已取消"));
    signal?.addEventListener("abort", () => xhr.abort());
    const fd = new FormData();
    fd.set("sha256", parts.sha256);
    fd.set("file", parts.file, parts.filename);
    if (parts.preview) fd.set("preview", parts.preview, "preview.jpg");
    if (parts.thumbnail) fd.set("thumbnail", parts.thumbnail, "thumb");
    if (parts.analysis) fd.set("analysis", parts.analysis, "analysis");
    if (parts.cutout) fd.set("cutout", parts.cutout, "cutout.png");
    xhr.send(fd);
  });
}

export const STATUS_LABEL: Record<string, string> = {
  active: "已入庫",
  review: "待確認",
  archived: "已封存",
  awaiting_image: "等待圖片",
  done: "完成",
  failed: "失敗",
  open: "進行中",
  finalized: "已完成",
};

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("zh-HK", { year: "numeric", month: "short", day: "numeric" });
}
