/**
 * Phase 3.9A.1.1：衣櫃排序規則（純函數，伺服器排序以外的本機排序及穿著排序共用）。
 *
 * 穿著資料只來自「已穿著」日誌（計劃／靈感不計），每件衣物每日最多一次（見 worker/diary.ts wearSummary）。
 * 穩定規則：
 * - 價錢：未填價錢永遠排最後；同價按最新加入、再按 ID。
 * - 最常穿著：穿著日數多 → 最近穿著較近 → 最新加入 → ID；從未穿著排最後。
 * - 最近穿著：最近穿著日期較近 → 穿著日數多 → 最新加入 → ID；從未穿著排最後。
 * - 最久未穿：已穿過的衣物按最近穿著日期由舊至新；從未穿著排最後（另有「從未穿著優先」）。
 * - 從未穿著優先：從未穿著（按最早加入，即擱置最久）→ 其餘按最久未穿。
 */
export type WearMap = Record<string, [days: number, last: string]>;
export interface SortableGarment { id: string; name: string; price?: number | null; created_at: string; updated_at?: string }

export const WEAR_SORTS = ["most_worn", "recent_worn", "least_recent", "never_first"] as const;
export type WearSort = (typeof WEAR_SORTS)[number];
export const isWearSort = (s: string): s is WearSort => (WEAR_SORTS as readonly string[]).includes(s);

export const SORT_LABEL: Record<string, string> = {
  "": "最新加入", oldest: "最早加入", updated: "最近修改", name: "名稱", price_desc: "價格高至低", price_asc: "價格低至高",
  most_worn: "最常穿著", recent_worn: "最近穿著", least_recent: "最久未穿", never_first: "從未穿著優先",
};

const byId = (a: SortableGarment, b: SortableGarment) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const newest = (a: SortableGarment, b: SortableGarment) => b.created_at.localeCompare(a.created_at) || byId(a, b);

export function wearComparator(sort: WearSort, wear: WearMap) {
  const d = (g: SortableGarment) => wear[g.id]?.[0] ?? 0;
  const last = (g: SortableGarment) => wear[g.id]?.[1] ?? "";
  const neverLast = (a: SortableGarment, b: SortableGarment) => (d(a) ? 0 : 1) - (d(b) ? 0 : 1);
  switch (sort) {
    case "most_worn": return (a: SortableGarment, b: SortableGarment) => neverLast(a, b) || d(b) - d(a) || last(b).localeCompare(last(a)) || newest(a, b);
    case "recent_worn": return (a: SortableGarment, b: SortableGarment) => neverLast(a, b) || last(b).localeCompare(last(a)) || d(b) - d(a) || newest(a, b);
    case "least_recent": return (a: SortableGarment, b: SortableGarment) => neverLast(a, b) || last(a).localeCompare(last(b)) || d(a) - d(b) || newest(a, b);
    case "never_first": return (a: SortableGarment, b: SortableGarment) => -neverLast(a, b) || (d(a) ? last(a).localeCompare(last(b)) || d(a) - d(b) : a.created_at.localeCompare(b.created_at)) || byId(a, b);
  }
}

/** 回傳新陣列（不改動原本清單） */
export function sortByWear<T extends SortableGarment>(list: T[], sort: WearSort, wear: WearMap): T[] {
  return [...list].sort(wearComparator(sort, wear));
}
