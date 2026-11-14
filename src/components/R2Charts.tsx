// Phase 3.8B.1：R2 儀表板的輕量 SVG 圖表（不引入圖表庫）。全部顏色使用主題 CSS 變數。
import { useMemo, useState } from "react";
import { DayPoint } from "../r2format";

const W = 340, H = 132, PL = 6, PR = 6, PT = 14, PB = 20;
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/**
 * 每日趨勢：柱狀（操作次數）或折線（容量、累計）。單一數列、單一 Y 軸。
 * - null＝沒有官方資料：以虛線短標記顯示「缺口」，不畫成 0。
 * - partial（今日未完結）：較淡顯示。
 * - 點擊／觸控：顯示日期、數值及資料來源。
 */
export function TrendChart({ points, kind, format, label, color = "var(--aw-chart-1)", source, testid }: { points: DayPoint[]; kind: "bar" | "line"; format: (n: number) => string; label: string; color?: string; source: string; testid?: string }) {
  const [pick, setPick] = useState<number | null>(null);
  const max = useMemo(() => Math.max(1, ...points.map((p) => p.value ?? 0)), [points]);
  const n = points.length || 1;
  const step = (W - PL - PR) / n;
  const x = (i: number) => PL + step * i + step / 2;
  const y = (v: number) => PT + (H - PT - PB) * (1 - v / max);
  const base = H - PB;
  const sel = pick != null ? points[pick] : null;
  // 折線：缺失日期分段（不跨過缺口連線）
  const segs: string[] = [];
  if (kind === "line") {
    let cur = "";
    points.forEach((p, i) => { if (p.value == null) { if (cur) segs.push(cur); cur = ""; } else cur += `${cur ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`; });
    if (cur) segs.push(cur);
  }
  const onPoint = (clientX: number, el: SVGSVGElement) => { const r = el.getBoundingClientRect(); const i = Math.floor(((clientX - r.left) / r.width * W - PL) / step); setPick(i >= 0 && i < n ? i : null); };
  const missing = points.filter((p) => p.value == null).length;
  return (
    <figure className="space-y-1" data-testid={testid} data-points={points.length} data-missing={missing}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full touch-pan-y select-none" role="img" aria-label={`${label}：${points.map((p) => `${p.date} ${p.value == null ? "沒有資料" : format(p.value)}`).join("、")}`}
        onPointerDown={(e) => onPoint(e.clientX, e.currentTarget)} onPointerMove={(e) => { if (e.buttons || e.pointerType === "mouse") onPoint(e.clientX, e.currentTarget); }}>
        <line x1={PL} x2={W - PR} y1={base} y2={base} style={{ stroke: "color-mix(in srgb, var(--aw-text2) 45%, transparent)" }} strokeWidth={1} />
        <line x1={PL} x2={W - PR} y1={PT} y2={PT} style={{ stroke: "color-mix(in srgb, var(--aw-text2) 18%, transparent)" }} strokeWidth={1} strokeDasharray="2 3" />
        <text x={PL} y={PT - 4} fontSize={9} style={{ fill: "var(--aw-text2)" }}>{format(max)}</text>
        {points.map((p, i) => p.value == null ? (
          <line key={p.date} x1={x(i) - Math.min(4, step * 0.3)} x2={x(i) + Math.min(4, step * 0.3)} y1={base - 3} y2={base - 3} style={{ stroke: "var(--aw-text2)" }} strokeWidth={1.2} strokeDasharray="1.5 1.5" data-missing-day={p.date} />
        ) : kind === "bar" ? (
          <rect key={p.date} x={x(i) - Math.max(1, step * 0.32)} width={Math.max(2, step * 0.64)} y={Math.min(y(p.value), base - (p.value > 0 ? 1.5 : 0))} height={Math.max(p.value > 0 ? 1.5 : 0, base - y(p.value))} rx={Math.min(2, step * 0.2)} style={{ fill: color, opacity: p.partial ? 0.45 : pick === i ? 1 : 0.88 }} data-day={p.date} />
        ) : null)}
        {kind === "line" && segs.map((d, i) => <path key={i} d={d} fill="none" style={{ stroke: color }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
        {kind === "line" && points.map((p, i) => p.value != null && (pick === i || points.length <= 8) ? <circle key={p.date} cx={x(i)} cy={y(p.value)} r={pick === i ? 4 : 2.5} style={{ fill: color, stroke: "var(--aw-card)" }} strokeWidth={1.5} /> : null)}
        {sel && <line x1={x(pick!)} x2={x(pick!)} y1={PT} y2={base} style={{ stroke: "var(--aw-text2)" }} strokeWidth={1} strokeDasharray="2 2" />}
        {points.length > 0 && <>
          <text x={PL} y={H - 6} fontSize={9} style={{ fill: "var(--aw-text2)" }}>{md(points[0].date)}</text>
          <text x={W - PR} y={H - 6} fontSize={9} textAnchor="end" style={{ fill: "var(--aw-text2)" }}>{md(points[points.length - 1].date)}</text>
        </>}
      </svg>
      <figcaption className="min-h-[2.2em] text-[11.5px] leading-snug text-mauve" data-testid={testid ? testid + "-tip" : undefined} aria-live="polite">
        {sel ? <><b className="text-cream">{sel.date}</b>｜{label}：<b className="text-cream">{sel.value == null ? "沒有官方資料（不是 0）" : format(sel.value)}</b>{sel.partial ? "（今日未完結）" : ""}<br />來源：{source}</>
          : <>點擊圖表查看每日數值。{missing > 0 && <>虛線＝沒有官方資料的日子（{missing} 日），不當作 0。</>}</>}
      </figcaption>
    </figure>
  );
}

/** 免費額度進度條：實際用量、上限、精確比例、剩餘或超出 */
export function QuotaBar({ title, sub, used, limit, q, lvl, fmt, testid }: { title: string; sub: string; used: string; limit: string; q: { bar: number; label: string; remaining: number | null; over: number | null }; lvl: string; fmt: (n: number) => string; testid: string }) {
  const color = lvl === "over" || lvl === "high" ? "var(--color-wine)" : lvl === "warn" ? "color-mix(in srgb, var(--color-wine) 55%, var(--aw-chart-1))" : "var(--aw-chart-1)";
  return (
    <div className="space-y-1" data-testid={testid} data-level={lvl} data-bar={q.bar.toFixed(4)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px]">{title}<span className="ml-1 text-[11px] text-mauve">{sub}</span></span>
        <b className="shrink-0 tabular-nums text-[13px] text-gold-soft" data-testid={testid + "-pct"}>{q.label}</b>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full" style={{ background: "color-mix(in srgb, var(--aw-text2) 20%, transparent)" }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(q.bar * 100)} aria-label={`${title} ${q.label}`}>
        <div className="h-full rounded-full transition-[width]" style={{ width: `${q.bar * 100}%`, background: color }} />
      </div>
      <p className="flex justify-between gap-2 text-[11px] tabular-nums text-mauve">
        <span>{used}／{limit}</span>
        <span>{q.over ? <b data-status-color className="text-danger-ink">超出 {fmt(q.over)}</b> : q.remaining != null ? `剩餘 ${fmt(q.remaining)}` : "數據未知"}</span>
      </p>
    </div>
  );
}

/** 小型分段切換 */
export function Seg<T extends string>({ value, opts, on, label, testid }: { value: T; opts: [T, string][]; on: (v: T) => void; label: string; testid?: string }) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={label} data-testid={testid}>
      {opts.map(([k, l]) => <button key={k} type="button" aria-pressed={value === k} data-seg={k} onClick={() => on(k)} className={`h-7 rounded-full px-2.5 text-[12px] ${value === k ? "chip-on" : "chip"}`}>{l}</button>)}
    </div>
  );
}
