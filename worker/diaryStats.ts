/** Phase 3.9A.1：穿著統計的純函數（沒有其他依賴，方便測試） */
export interface WearDay { garment_id: string; worn_date: string; entries: number }
/** 計算規則（純函數，方便測試）：每件衣物每日最多一次；只計已穿著；price 未填＝每次成本未知 */
export function wearStats(days: WearDay[], today: string) {
  const map = new Map<string, { days: number; entries: number; first: string; last: string; month: number; year: number }>();
  const m = today.slice(0, 7), y = today.slice(0, 4);
  for (const d of days) {
    const s = map.get(d.garment_id) ?? { days: 0, entries: 0, first: d.worn_date, last: d.worn_date, month: 0, year: 0 };
    s.days++; s.entries += d.entries;
    if (d.worn_date < s.first) s.first = d.worn_date;
    if (d.worn_date > s.last) s.last = d.worn_date;
    if (d.worn_date.startsWith(m)) s.month++;
    if (d.worn_date.startsWith(y)) s.year++;
    map.set(d.garment_id, s);
  }
  return map;
}
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
export const costPerWear = (price: number | null | undefined, days: number) => (price == null || !(price > 0) || days <= 0 ? null : Math.round((price / days) * 100) / 100);

