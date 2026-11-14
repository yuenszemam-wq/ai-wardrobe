/** Phase 3.8B.1：R2 儀表板的數字格式（極低比例仍可讀；超過 100% 顯示真實比例；未知不顯示為 0） */
export const fmtN = (x: number | null | undefined) => (x == null ? "—" : Math.round(x).toLocaleString("en-US"));
export const fmtSize = (b: number | null | undefined) => (b == null ? "—" : b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : b >= 1e3 ? (b / 1e3).toFixed(0) + " KB" : b + " B");
export const fmtUsd = (x: number | null | undefined) => (x == null ? "未知" : "US$" + (x === 0 ? "0" : x.toFixed(x < 1 ? 4 : 2)));

/** 比例（0–∞）→ 文字：0.00067 → 0.067%；極小 → <0.001%；0 → 0% */
export function fmtPct(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return "未知";
  const p = ratio * 100;
  if (p === 0) return "0%";
  if (p < 0.001) return "<0.001%";
  const digits = p < 0.01 ? 4 : p < 0.1 ? 3 : p < 1 ? 2 : p < 10 ? 2 : 1;
  return String(Number(p.toFixed(digits))) + "%";
}

/** 免費額度進度條：bar（0–1，超過 100% 保持滿格）、真實比例文字、剩餘及超出量 */
export function quota(used: number | null | undefined, limit: number) {
  if (used == null || !Number.isFinite(used)) return { bar: 0, ratio: null as number | null, label: "未知", remaining: null as number | null, over: null as number | null };
  const ratio = used / limit;
  // 極低用量仍顯示一小段（最少 0.6%），讓使用者看到不是空白；文字顯示精確比例
  const bar = ratio <= 0 ? 0 : Math.min(1, Math.max(0.006, ratio));
  return { bar, ratio, label: fmtPct(ratio), remaining: Math.max(0, limit - used), over: Math.max(0, used - limit) };
}

/** 警告等級：按現有門檻（例如 70／85／95） */
export function level(ratio: number | null, warn: number[]): "ok" | "warn" | "high" | "over" | "unknown" {
  if (ratio == null) return "unknown";
  if (ratio >= 1) return "over";
  const p = ratio * 100, sorted = [...warn].sort((a, b) => a - b);
  if (sorted.length && p >= sorted[sorted.length - 1]) return "high";
  if (sorted.length && p >= sorted[0]) return "warn";
  return "ok";
}

export interface DayPoint { date: string; value: number | null; partial?: boolean }
/** 累計：只累加有官方數據的日子；缺失日子不當作 0，保留 null 以便圖表顯示缺口 */
export function cumulative(points: DayPoint[]): DayPoint[] {
  let acc = 0;
  return points.map((p) => (p.value == null ? { ...p, value: null } : { ...p, value: (acc += p.value) }));
}
/** 時間範圍：最近 7 日、最近 30 日、本月（UTC 日期，與 Cloudflare 計費月份一致） */
export function rangeDays<T extends { date: string }>(days: T[], range: "7d" | "30d" | "month", today: string): T[] {
  if (range === "month") return days.filter((d) => d.date.slice(0, 7) === today.slice(0, 7));
  const n = range === "7d" ? 7 : 30;
  return days.slice(-n);
}
