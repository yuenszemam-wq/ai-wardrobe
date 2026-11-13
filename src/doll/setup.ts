// 衣服設定工作室（Phase 3.4）：每件衣物的預設穿著設定狀態。
// 不只看「有沒有衣物預設記錄」：位置、變形、遮罩、骨架各自判斷，亦可以手動標記「已完成／不需要」。
import { Piece, SETUP_KEYS, SLOT_SKIN, SetupKey, SetupMark, Slot, TemplateData, isSlot, slotFor } from "../../shared/doll";
import { GarmentLite, Template, Templates } from "./model";

/** 單一項目的狀態：done＝已校正；na＝不需要；todo＝未設定（需要處理）；optional＝未設定但可選 */
export type ItemState = "done" | "na" | "todo" | "optional" | "auto" | "review";
export const ITEM_LABEL: Record<ItemState, string> = { done: "已設定", na: "不需要", todo: "未設定", auto: "自動初始值", review: "已有預設，待確認", optional: "未設定（可選）" };
/** 整件衣物：未設定／部分設定／已設定／圖片已更新需要重新檢查 */
export type Overall = "none" | "partial" | "done" | "stale";
export const OVERALL_LABEL: Record<Overall, string> = { none: "未設定", partial: "部分設定", done: "已設定", stale: "需要重新校正" };

export interface SetupInfo {
  overall: Overall;
  items: Record<SetupKey, ItemState>;
  /** 拆件：部件數目及其中已校正位置的數目 */
  pieces: { total: number; set: number } | null;
  updated_at: string | null;
  template: Template | null;
  slot: Slot;
  /** 自訂身體：未有自己的設定，但有 Avatar V2 設定可以換算成初始位置 */
  convertible: boolean;
}

/** 程式判斷＋手動標記。手動標記優先。 */
export function setupInfo(g: GarmentLite, tpls: Templates): SetupInfo {
  const raw = tpls.v2.get(g.id) ?? null;
  const baseRaw = !raw && tpls.base ? tpls.base.get(g.id) ?? null : null;
  const convertible = !!baseRaw && baseRaw.image_id === (g.transparent_image_id ?? null);
  const stale = !!raw && raw.image_id !== (g.transparent_image_id ?? null);
  const t = raw && !stale ? raw : null;
  const slot: Slot = t && isSlot(t.slot) ? t.slot : baseRaw && isSlot(baseRaw.slot) ? baseRaw.slot : slotFor(g.category, g.subcategory);
  const d = t?.data ?? null;
  const marks: Partial<Record<SetupKey, SetupMark>> = d?.status ?? {};
  const skin = SLOT_SKIN[slot];
  const auto: Record<SetupKey, ItemState> = {
    place: t ? "review" : "auto",
    mesh: t?.fit.mesh ? "review" : "optional",
    mask: d?.mask ? "review" : "optional",
    // 半裙、配件、頭飾等整件移動的衣物不需要骨架設定
    rig: skin === "rigid" ? "na" : d ? "review" : "auto",
  };
  const items = Object.fromEntries(SETUP_KEYS.map((k) => [k, marks[k] ?? auto[k]])) as Record<SetupKey, ItemState>;
  const pcs: Piece[] = d?.pieces ?? [];
  const pieces = pcs.length ? { total: pcs.length, set: pcs.filter((p) => p.status?.place === "done" || p.status?.place === "na").length } : null;
  let overall: Overall;
  if (stale) overall = "stale";
  else if (!t) overall = "none";
  else overall = SETUP_KEYS.some((k) => !["done", "na", "optional"].includes(items[k])) || (pieces && pieces.set < pieces.total) ? "partial" : "done";
  return { overall, items, pieces, updated_at: raw?.updated_at ?? null, template: t, slot, convertible };
}

/** 套裝部件的設定狀態（部件不是新衣物；狀態存在部件自己的設定內） */
export function pieceSetup(p: Piece): Record<SetupKey, ItemState> {
  const skin = SLOT_SKIN[p.slot];
  const auto: Record<SetupKey, ItemState> = { place: p.fit ? "review" : "auto", mesh: p.fit?.mesh ? "review" : "optional", mask: p.wear_mask ? "review" : "optional", rig: skin === "rigid" ? "na" : p.opts ? "review" : "auto" };
  return Object.fromEntries(SETUP_KEYS.map((k) => [k, p.status?.[k] ?? auto[k]])) as Record<SetupKey, ItemState>;
}
