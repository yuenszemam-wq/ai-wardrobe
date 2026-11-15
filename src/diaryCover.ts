/**
 * Phase 3.9A.1.1：日誌封面解析（日誌頁、首頁照片日曆元件、穿著分析共用）。
 *
 * 預設優先次序（auto）：
 * 1. 使用者指定的真人照片封面（未指定時用第一張照片）
 * 2. 已保存角色換裝或衣服配搭的完整造型縮圖（source_thumb）
 * 3. 衣物歷史快照（第一件有快照的衣物）
 * 4. 沒有圖片 → null（呼叫者顯示圓點或圖示）
 *
 * 只有完整造型縮圖才會當作「整套造型」；衣物快照只標示為衣物（kind = "garment"），不會冒充整套穿搭。
 */
import type { DiaryEntry } from "./diary";
import { photoThumb, snapUrl } from "./diary";

export type CoverMode = "auto" | "photo" | "look" | "garment";
export const COVER_MODES: [CoverMode, string][] = [["auto", "自動"], ["photo", "優先真人照片"], ["look", "優先角色造型／衣服配搭"], ["garment", "只顯示衣物縮圖"]];
export interface Cover { src: string; kind: "photo" | "look" | "garment" }

type CoverEntry = Pick<DiaryEntry, "cover_photo_id" | "photos" | "items"> & { source_thumb?: string | null };

export function resolveCover(e: CoverEntry, mode: CoverMode = "auto"): Cover | null {
  const photoId = e.cover_photo_id ?? e.photos?.[0]?.id ?? null;
  const photo: Cover | null = photoId ? { src: photoThumb(photoId), kind: "photo" } : null;
  const look: Cover | null = e.source_thumb ? { src: e.source_thumb, kind: "look" } : null;
  const snap = e.items?.find((i) => i.snap_id)?.snap_id;
  const garment: Cover | null = snap ? { src: snapUrl(snap), kind: "garment" } : null;
  const order = mode === "look" ? [look, photo, garment] : mode === "garment" ? [garment] : [photo, look, garment];
  return order.find((c): c is Cover => !!c) ?? null;
}

export const coverSrc = (e: CoverEntry, mode: CoverMode = "auto") => resolveCover(e, mode)?.src ?? null;
