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
  status: "active" | "review" | "archived";
  is_favorite: boolean;
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
