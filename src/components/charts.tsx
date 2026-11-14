import { ReactNode } from "react";

/** 分類色（深紫絲絨底上要分得開）：粉、薰衣草、玫瑰金、莓紅、霧藍、奶油、灰紫、橄欖 */
// 第一個顏色跟隨介面主題的圖表色；原本的奶油色在淺色主題看不見，改用主題的金色文字色
// Phase 3.8A.2：全部系列跟隨主題的圖表色票（主要＋4 個系列色），之後以標題色及其混色延伸
export const SERIES = ["var(--aw-chart-1)", "var(--aw-chart-2)", "var(--aw-chart-3)", "var(--aw-chart-4)", "var(--aw-chart-5)", "var(--color-gold-soft)", "color-mix(in srgb, var(--aw-chart-1) 50%, var(--aw-chart-3))", "color-mix(in srgb, var(--aw-chart-2) 50%, var(--aw-chart-4))"];

export const COLOR_HEX: Record<string, string> = {
  黑: "#17101a",
  白: "#ffffff",
  灰: "#9a9aa2",
  粉紅: "#f4a9c8",
  紅: "#b5253f",
  紫: "#8a5fc0",
  藍: "#4f74c9",
  綠: "#5c9a72",
  黃: "#ecd06a",
  橙: "#e8944a",
  啡: "#7a5238",
  米色: "#ead9bd",
  金: "#cfa75a",
  銀: "#c9ccd3",
};
/** 顏色名稱 → CSS 背景（不認識的名稱用斜紋表示） */
export function swatch(name: string): string {
  if (COLOR_HEX[name]) return COLOR_HEX[name];
  if (name === "多色") return "conic-gradient(#f4a9c8, #ecd06a, #5c9a72, #4f74c9, #8a5fc0, #f4a9c8)";
  return "repeating-linear-gradient(45deg, var(--aw-text2) 0 3px, var(--aw-card2) 3px 6px)";
}

export interface Seg {
  name: string;
  n: number;
  color?: string;
}

/** 超過 max 項時，把尾段合併成「其他」 */
export function topWithOther<T extends { name: string; n: number }>(list: T[], max: number): { name: string; n: number }[] {
  if (list.length <= max) return list;
  const head = list.slice(0, max - 1);
  return [...head, { name: "其他", n: list.slice(max - 1).reduce((s, x) => s + x.n, 0) }];
}

/** 環形圖：中央放總數。每段之間留一點空隙，尾端圓角 */
export function Donut({ segs, size = 150, thickness = 15, children }: { segs: Seg[]; size?: number; thickness?: number; children?: ReactNode }) {
  const total = segs.reduce((s, x) => s + x.n, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const gap = segs.length > 1 ? 3 : 0;
  let acc = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="-rotate-90" role="img" aria-label={segs.map((s) => `${s.name} ${s.n}`).join("、")}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" style={{ stroke: "color-mix(in srgb, var(--aw-line) 18%, transparent)" }} strokeWidth={thickness} />
        {total > 0 &&
          segs.map((s, i) => {
            const len = (s.n / total) * c;
            const dash = Math.max(len - gap, 0.5);
            const el = (
              <circle
                key={s.name}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color ?? SERIES[i % SERIES.length]}
                strokeWidth={thickness}
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={-acc - gap / 2}
              />
            );
            acc += len;
            return el;
          })}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

/** 橫條清單：名稱、數值、比例條 */
export function Bars({
  rows,
  max,
  format = (n) => String(n),
  color = "linear-gradient(90deg, var(--aw-primary), var(--aw-chart))",
  onPick,
}: {
  rows: { name: string; n: number; sub?: string; dot?: string }[];
  max?: number;
  format?: (n: number) => string;
  color?: string;
  onPick?: (name: string) => void;
}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.n));
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-2 text-[13px]">
              <span className="flex min-w-0 items-center gap-1.5">
                {r.dot && <span className="h-3 w-3 shrink-0 rounded-full ring-1 ring-gold/60" style={{ background: r.dot }} />}
                <span className="truncate">{r.name}</span>
              </span>
              <span className="shrink-0 tabular-nums text-mauve">
                {format(r.n)}
                {r.sub ? <span className="ml-1.5 text-[11px]">{r.sub}</span> : null}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-gold/15">
              <div className="h-full rounded-full" style={{ width: `${Math.max(2, (r.n / top) * 100)}%`, background: color }} />
            </div>
          </>
        );
        return (
          <li key={r.name}>
            {onPick ? (
              <button type="button" className="block w-full text-left" onClick={() => onPick(r.name)}>
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}

export const pct = (n: number, total: number) => (total ? `${Math.round((n / total) * 100)}%` : "0%");
