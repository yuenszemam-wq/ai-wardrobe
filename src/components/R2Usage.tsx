// Phase 3.8B.1：R2 用量及費用儀表板。
// 由上至下：本月費用總覽 → 免費額度 → 每日趨勢 → Bucket 分布 → App 用途 → 本機快取 → 提醒及保護 → 進階資訊。
// Cloudflare 帳戶官方數據與 AI Wardrobe 自身估算分開標示；取不到官方數據時不顯示虛構數字。
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { imageCacheUsage, localHitCount } from "../imageCache";
import { DayPoint, cumulative, fmtN, fmtPct, fmtSize, fmtUsd, level, quota, rangeDays } from "../r2format";
import { Bars, Donut, SERIES } from "./charts";
import { QuotaBar, Seg, TrendChart } from "./R2Charts";
import { Button, Spinner, toast } from "./ui";

interface DayRow { date: string; class_a: number | null; class_b: number | null; free: number | null; unknown: number | null; storage_bytes: number | null; objects: number | null; partial?: boolean }
interface Cost { storage: number | null; class_a: number; class_b: number; known: number; total: number | null; partial: boolean; unknown_ops: number; stale?: boolean }
interface Usage {
  pricing: { checked_at: string; source: string; storage_class: string; free: { gb_month: number; class_a: number; class_b: number }; price: { gb_month: number; class_a_per_million: number; class_b_per_million: number }; egress: string; billing_period_days: number; rounding: string };
  purposes: [string, string][];
  official: { available: boolean; reason?: string; missing?: string[]; message?: string; fetched_at?: string; delay_note?: string; stale?: boolean; stale_reason?: string; stale_message?: string; attempted_at?: string; cooldown_s?: number;
    account?: { class_a: number; class_b: number; free: number; unknown: number; unknown_actions: string[]; storage_bytes: number | null; objects: number | null; gb_month_est: number | null; storage_days: number; days: number; days_in_month: number; month: string };
    buckets?: Record<string, { class_a: number; class_b: number; free: number; unknown: number; storage_bytes: number | null; objects: number | null }>;
    daily?: { available: boolean; note?: string; start: string; end: string; days: DayRow[]; truncated: boolean } };
  app: { env: string; month: string; storage: Record<string, { objects: number; bytes: number }>; ops: { purpose: string; op: string; n: number }[]; counting: boolean; thumbnail_backfill_reads: number; note: string };
  alerts: { warn: number[]; soft_limit: number };
  free_use: { source: "official" | "app_estimate"; stale?: boolean; class_a: number; class_b: number; storage: number | null };
  cost: Cost | null;
  forecast: { available: false; reason: string } | { available: true; basis: { from: string; to: string; days: number; storage_days: number; missing_days: number }; assumptions: string; class_a: number; class_b: number; gb_month: number | null; cost: Cost; stale: boolean };
  background: { allowed: boolean; reason?: string; source?: string; stale?: boolean };
}
const SOURCE = "Cloudflare 官方 Analytics（帳戶所有 Bucket）";
const COOLDOWN = 30_000;
const PROD = "ai-wardrobe-images", PREVIEW = "ai-wardrobe-preview-images";
const envOf = (b: string) => (b === PROD ? "正式環境" : b === PREVIEW ? "預覽環境" : "其他 Cloudflare 專案");
const gbm = (x: number) => (x < 0.01 ? x.toFixed(4) : x.toFixed(3)) + " GB-month";

/** 讀取用量：請求去重、序號防止較舊回應覆蓋較新回應、手動重新整理冷卻 */
function useUsage() {
  const [u, setU] = useState<Usage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0), inflight = useRef<Promise<void> | null>(null), lastManual = useRef(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const load = useCallback((refresh = false) => {
    if (refresh) {
      const now = Date.now();
      if (now - lastManual.current < COOLDOWN) { toast(`剛剛已更新，請 ${Math.ceil((COOLDOWN - (now - lastManual.current)) / 1000)} 秒後再試`, "err"); return Promise.resolve(); }
      lastManual.current = now; setCooldownUntil(now + COOLDOWN);
    } else if (inflight.current) return inflight.current;
    const id = ++seq.current;
    setBusy(true);
    const p = api<Usage>(`/api/r2/usage${refresh ? "?refresh=1" : ""}`)
      .then((r) => { if (id === seq.current) { setU(r); setErr(null); if (refresh && r.official.cooldown_s) toast(`伺服器剛剛已更新數據（${r.official.cooldown_s} 秒後可再重新整理）`); } })
      .catch((e) => { if (id === seq.current) setErr((e as Error).message); })
      .finally(() => { if (id === seq.current) setBusy(false); if (inflight.current === p) inflight.current = null; });
    inflight.current = p;
    return p;
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { u, err, busy, load, cooldownUntil };
}

export function R2Usage({ advanced }: { advanced?: ReactNode }) {
  const { u, err, busy, load, cooldownUntil } = useUsage();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (cooldownUntil <= Date.now()) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [cooldownUntil]);
  if (!u) return err ? <div className="frame space-y-2 p-4 text-[13px]" role="alert"><p>未能讀取用量：{err}</p><Button variant="ghost" onClick={() => void load()}>再試</Button><p className="text-[11px] text-mauve">查看衣櫃及保存功能不受影響。</p></div> : <Spinner />;
  const o = u.official, a = o.account, f = u.pricing.free;
  const highest = Math.max(u.free_use.class_a, u.free_use.class_b, u.free_use.storage ?? 0) * 100;
  const warnAt = [...u.alerts.warn].reverse().find((w) => highest >= w);
  const cooling = cooldownUntil > now;
  const status = !o.available ? (o.reason === "missing_config" ? "未設定官方數據" : "官方數據暫時無法取得") : o.stale ? "官方數據（可能已過時）" : "官方數據";
  const inFree = u.cost ? (u.cost.total === 0 ? "yes" : u.cost.total == null ? (u.cost.known > 0 ? "no" : "unknown") : "no") : "unknown";
  return (
    <div className="space-y-3 text-[13px]" data-testid="r2-usage" data-official={o.available ? "1" : "0"} data-reason={o.reason ?? ""} data-stale={o.stale ? "1" : "0"}>
      {warnAt != null && <p role="alert" data-status-color className="rounded-2xl bg-danger/30 px-3 py-2 text-[12.5px] text-danger-ink" data-testid="r2-warning">R2 免費額度已用約 {Math.round(highest)}%（警告門檻 {warnAt}%）{u.free_use.source === "app_estimate" ? "；這是 App 自身統計的估算，未包括其他專案" : ""}。</p>}
      {!u.background.allowed && <p className="rounded-2xl bg-cream/5 px-3 py-2 text-[12px]" data-testid="r2-protect">{u.background.reason}。正常查看已存在的衣櫃及圖片、上傳及保存不受影響。</p>}

      {/* 1. 本月費用總覽 */}
      <section className="frame space-y-2 p-4" data-testid="r2-summary">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11.5px] text-mauve">本月額外費用估算{a ? `（${a.month}）` : ""}</p>
            <p className="font-serif text-[26px] leading-tight text-gold-soft" data-testid="r2-cost-total">{u.cost ? fmtUsd(u.cost.total) : "—"}</p>
            {u.cost?.partial && u.cost.total == null && <p className="text-[11px] text-mauve" data-testid="r2-cost-partial">儲存計費資料缺失：已知部分 {fmtUsd(u.cost.known)}，總額未能估算（不當作 US$0）</p>}
            {(u.cost?.unknown_ops ?? 0) > 0 && <p className="text-[11px] text-mauve">另有 {fmtN(u.cost!.unknown_ops)} 次未分類操作（{a?.unknown_actions.join("、")}），未計入費用。</p>}
          </div>
          <Button variant="ghost" disabled={busy || cooling} onClick={() => void load(true)} data-testid="r2-refresh">{busy ? "更新中…" : cooling ? `${Math.ceil((cooldownUntil - now) / 1000)} 秒` : "重新整理"}</Button>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[11.5px]">
          <span className={`rounded-full px-2.5 py-0.5 ${inFree === "yes" ? "chip-on" : "chip"}`} data-testid="r2-free-status" data-free={inFree}>{inFree === "yes" ? "仍在免費額度內" : inFree === "no" ? "已超出免費額度" : "未能確定是否在免費額度內"}</span>
          <span className="chip rounded-full px-2.5 py-0.5" data-testid="r2-source">{status}</span>
          <span className="chip rounded-full px-2.5 py-0.5">最後更新：{o.fetched_at ? new Date(o.fetched_at).toLocaleString("zh-HK", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}</span>
        </div>
        {o.stale && <p className="rounded-xl bg-cream/5 px-3 py-1.5 text-[11.5px]" data-testid="r2-stale">最近一次更新失敗（{o.stale_message ?? o.stale_reason}），現在顯示上次成功取得的數據，可能已過時。</p>}
        {u.cost && !u.cost.partial && u.cost.total != null && u.cost.total > 0 && <p className="text-[11.5px] text-mauve">儲存 {fmtUsd(u.cost.storage)}、Class A {fmtUsd(u.cost.class_a)}、Class B {fmtUsd(u.cost.class_b)}（按官方規則向上取整計費單位）</p>}
        {!o.available && <OfficialMissing o={o} />}
      </section>

      {/* 2. 免費額度 */}
      <section className="frame space-y-3 p-4" data-testid="r2-quota">
        <h3 className="font-serif text-[15px] text-gold-soft">免費額度使用情況</h3>
        {a ? <>
          <QuotaBar testid="r2-q-storage" title="計費儲存量" sub="GB-month" used={a.gb_month_est == null ? "未知" : gbm(a.gb_month_est)} limit={`${f.gb_month} GB-month`} q={quota(a.gb_month_est, f.gb_month)} lvl={level(u.free_use.storage, u.alerts.warn)} fmt={(x) => gbm(x)} />
          <QuotaBar testid="r2-q-a" title="Class A" sub="寫入、列出" used={fmtN(a.class_a)} limit={fmtN(f.class_a)} q={quota(a.class_a, f.class_a)} lvl={level(u.free_use.class_a, u.alerts.warn)} fmt={(x) => fmtN(x) + " 次"} />
          <QuotaBar testid="r2-q-b" title="Class B" sub="讀取" used={fmtN(a.class_b)} limit={fmtN(f.class_b)} q={quota(a.class_b, f.class_b)} lvl={level(u.free_use.class_b, u.alerts.warn)} fmt={(x) => fmtN(x) + " 次"} />
          <p className="text-[11px] text-mauve">目前容量 {fmtSize(a.storage_bytes)}{a.objects != null ? `（${fmtN(a.objects)} 個物件）` : ""}不等於 GB-month：GB-month 是每日最高容量在 30 日計費期間的平均（本月已有 {a.storage_days} 日官方容量數據）。</p>
        </> : <>
          <p className="text-[12px] text-mauve">沒有官方數據。以下只是 AI Wardrobe 自身統計的操作次數（不包括其他專案），儲存量無法換算 GB-month。</p>
          <QuotaBar testid="r2-q-a" title="Class A（App 估算）" sub="寫入、列出" used={fmtN(u.free_use.class_a * f.class_a)} limit={fmtN(f.class_a)} q={quota(u.free_use.class_a * f.class_a, f.class_a)} lvl={level(u.free_use.class_a, u.alerts.warn)} fmt={(x) => fmtN(x) + " 次"} />
          <QuotaBar testid="r2-q-b" title="Class B（App 估算）" sub="讀取" used={fmtN(u.free_use.class_b * f.class_b)} limit={fmtN(f.class_b)} q={quota(u.free_use.class_b * f.class_b, f.class_b)} lvl={level(u.free_use.class_b, u.alerts.warn)} fmt={(x) => fmtN(x) + " 次"} />
        </>}
      </section>

      {/* 3. 每日趨勢 */}
      {o.available && <Trends u={u} />}

      {/* 4. Bucket 分布 */}
      {o.available && o.buckets && <Buckets buckets={o.buckets} />}

      {/* 月底預測（可選） */}
      {o.available && <Forecast u={u} />}

      {/* 5. App 用途 */}
      <AppPurposes u={u} />

      {/* 6. 本機快取 */}
      <LocalCache />

      {/* 7. 提醒及保護 */}
      <Alerts u={u} onSaved={() => void load()} />

      {/* 8. 進階技術資訊 */}
      <details className="frame p-4" data-testid="r2-advanced">
        <summary className="cursor-pointer text-gold-soft">進階技術資訊</summary>
        <div className="mt-2 space-y-2 text-[12px]">
          <p>定價（{u.pricing.storage_class}，{u.pricing.checked_at} 核對）：儲存 US${u.pricing.price.gb_month}／GB-month、Class A US${u.pricing.price.class_a_per_million}／百萬次、Class B US${u.pricing.price.class_b_per_million}／百萬次；對外傳輸{u.pricing.egress}。計費單位{u.pricing.rounding}。免費額度：每月 {f.gb_month} GB-month、Class A {fmtN(f.class_a)} 次、Class B {fmtN(f.class_b)} 次，<b>只適用於 Standard 儲存類型，並由整個 Cloudflare 帳戶共用</b>。<a className="underline" href={u.pricing.source} target="_blank" rel="noreferrer">官方定價</a></p>
          <p className="text-mauve">Class A：PutObject、ListObjects、CopyObject、CompleteMultipartUpload 等；Class B：GetObject、HeadObject 等；免費：DeleteObject、AbortMultipartUpload。文件沒有列出的操作標示為「未分類」，不會當作免費。</p>
          {o.delay_note && <p className="text-mauve">{o.delay_note}</p>}
          {o.daily && !o.daily.available && <p className="text-mauve">{o.daily.note}</p>}
          {o.daily?.truncated && <p data-status-color className="text-danger-ink">官方數據分組超過查詢上限，部分數據可能未包括。</p>}
          {advanced && <div className="border-t border-gold/20 pt-2"><p className="mb-1 text-gold-soft">伺服器縮圖狀態</p>{advanced}</div>}
        </div>
      </details>
    </div>
  );
}

function OfficialMissing({ o }: { o: Usage["official"] }) {
  return (
    <div className="rounded-2xl bg-cream/5 p-3 text-[12.5px]" data-testid="r2-official-missing">
      {o.reason === "missing_config" ? <>
        <p>未能讀取官方用量：Worker 缺少以下設定（不會顯示虛構數字）。</p>
        <ul className="mt-1 list-disc pl-4">{o.missing?.map((m) => <li key={m}>{m}</li>)}</ul>
        <details className="mt-1 text-[12px] text-mauve"><summary className="cursor-pointer">設定方法</summary>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4">
            <li>Cloudflare Dashboard → 我的個人資料 → API Tokens → 建立自訂 Token：權限只選「Account › Account Analytics › Read」。</li>
            <li>Workers &amp; Pages → ai-wardrobe → 設定 → 變數及密碼：新增 Secret「CF_API_TOKEN」。帳戶 ID 已在設定檔內。</li>
            <li>重新部署後回到這一頁按「重新整理」。Token 只保存在 Worker，不會出現在 App 或 GitHub。</li>
          </ol>
        </details>
      </> : <p>官方用量暫時無法取得：{o.message}</p>}
    </div>
  );
}

type Metric = "storage" | "class_a" | "class_b" | "cum" | "gbm";
function Trends({ u }: { u: Usage }) {
  const [range, setRange] = useState<"7d" | "30d" | "month">("30d");
  const [metric, setMetric] = useState<Metric>("class_b");
  const [cum, setCum] = useState<"class_a" | "class_b">("class_b");
  const d = u.official.daily;
  const today = d?.end ?? new Date().toISOString().slice(0, 10);
  const days = useMemo(() => (d?.available ? rangeDays(d.days, range, today) : []), [d, range, today]);
  if (!d?.available) return <section className="frame p-4 text-[12px] text-mauve" data-testid="r2-trend"><h3 className="mb-1 font-serif text-[15px] text-gold-soft">每日用量趨勢</h3>{d?.note ?? "暫時沒有官方每日數據。"}</section>;
  const pts = (k: keyof DayRow): DayPoint[] => days.map((r) => ({ date: r.date, value: r[k] as number | null, partial: r.partial }));
  // 累計：只計本月（與免費額度同一計費月份）
  const month = d.days.filter((r) => r.date.slice(0, 7) === today.slice(0, 7));
  const monthPts = (k: keyof DayRow): DayPoint[] => month.map((r) => ({ date: r.date, value: r[k] as number | null, partial: r.partial }));
  const gbmPts = cumulative(monthPts("storage_bytes")).map((p) => ({ ...p, value: p.value == null ? null : p.value / 1e9 / u.pricing.billing_period_days }));
  return (
    <section className="frame space-y-2 p-4" data-testid="r2-trend" data-range={range} data-metric={metric}>
      <h3 className="font-serif text-[15px] text-gold-soft">每日用量趨勢</h3>
      <Seg label="時間範圍" testid="r2-range" value={range} on={setRange} opts={[["7d", "最近 7 日"], ["30d", "最近 30 日"], ["month", "本月"]]} />
      <Seg label="指標" testid="r2-metric" value={metric} on={setMetric} opts={[["storage", "儲存容量"], ["class_a", "Class A"], ["class_b", "Class B"], ["cum", "本月累計"], ["gbm", "GB-month"]]} />
      {metric === "storage" && <TrendChart testid="r2-chart" kind="line" label="每日儲存容量" points={pts("storage_bytes")} format={fmtSize} source={SOURCE} color="var(--aw-chart-1)" />}
      {metric === "class_a" && <TrendChart testid="r2-chart" kind="bar" label="每日 Class A" points={pts("class_a")} format={(x) => fmtN(x) + " 次"} source={SOURCE} color="var(--aw-chart-2)" />}
      {metric === "class_b" && <TrendChart testid="r2-chart" kind="bar" label="每日 Class B" points={pts("class_b")} format={(x) => fmtN(x) + " 次"} source={SOURCE} color="var(--aw-chart-3)" />}
      {metric === "cum" && <>
        <Seg label="累計類別" testid="r2-cum" value={cum} on={setCum} opts={[["class_a", "Class A"], ["class_b", "Class B"]]} />
        <TrendChart testid="r2-chart" kind="line" label={`本月累計 ${cum === "class_a" ? "Class A" : "Class B"}`} points={cumulative(monthPts(cum))} format={(x) => fmtN(x) + " 次"} source={SOURCE + "；只累加有官方數據的日子"} color={cum === "class_a" ? "var(--aw-chart-2)" : "var(--aw-chart-3)"} />
      </>}
      {metric === "gbm" && <TrendChart testid="r2-chart" kind="line" label="本月 GB-month 累計（估算）" points={gbmPts} format={(x) => gbm(x)} source={SOURCE + "；每日最高容量 ÷ 30 日累加"} color="var(--aw-chart-4)" />}
      <p className="text-[11px] text-mauve">Class A 與 Class B 數量相差很大，所以分開顯示。日期為 UTC（與 Cloudflare 計費月份一致）。</p>
    </section>
  );
}

function Buckets({ buckets }: { buckets: NonNullable<Usage["official"]["buckets"]> }) {
  const [m, setM] = useState<"storage" | "class_a" | "class_b">("storage");
  const rows = Object.entries(buckets).map(([name, b]) => ({ name, env: envOf(name), n: m === "storage" ? b.storage_bytes ?? 0 : b[m] })).sort((x, y) => (x.env === "正式環境" ? -1 : y.env === "正式環境" ? 1 : x.env === "預覽環境" ? -1 : y.env === "預覽環境" ? 1 : y.n - x.n));
  const total = rows.reduce((s, r) => s + r.n, 0);
  const fmt = m === "storage" ? fmtSize : (x: number) => fmtN(x) + " 次";
  return (
    <section className="frame space-y-2 p-4" data-testid="r2-buckets" data-metric={m}>
      <h3 className="font-serif text-[15px] text-gold-soft">各 Bucket 用量分布<span className="ml-1 text-[11px] font-sans text-mauve">官方數據</span></h3>
      <Seg label="指標" testid="r2-bucket-metric" value={m} on={setM} opts={[["storage", "儲存容量"], ["class_a", "Class A"], ["class_b", "Class B"]]} />
      <div className="flex items-center gap-3">
        <Donut size={104} thickness={12} segs={rows.map((r, i) => ({ name: r.name, n: r.n, color: SERIES[i % SERIES.length] }))}><span className="text-[10px] leading-tight text-mauve">合計<br /><b className="text-[11px] text-cream">{fmt(total)}</b></span></Donut>
        <ul className="min-w-0 flex-1 space-y-1 text-[12px]">
          {rows.map((r, i) => (
            <li key={r.name} className="flex items-center gap-1.5" data-bucket={r.name} data-env={r.env}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SERIES[i % SERIES.length] }} />
              <span className="min-w-0 flex-1 truncate">{r.env}<span className="block truncate text-[10.5px] text-mauve">{r.name}</span></span>
              <span className="shrink-0 tabular-nums">{fmt(r.n)}<span className="ml-1 text-[10.5px] text-mauve">{total ? fmtPct(r.n / total) : ""}</span></span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Forecast({ u }: { u: Usage }) {
  const [on, setOn] = useState(() => { try { return localStorage.getItem("aw:r2-forecast") === "1"; } catch { return false; } });
  const toggle = () => { setOn(!on); try { localStorage.setItem("aw:r2-forecast", on ? "0" : "1"); } catch { /* ignore */ } };
  const fc = u.forecast, f = u.pricing.free;
  return (
    <section className="frame space-y-2 p-4" data-testid="r2-forecast" data-available={fc.available ? "1" : "0"}>
      <label className="flex items-center justify-between gap-2"><span className="font-serif text-[15px] text-gold-soft">月底預計用量（估算）</span><button type="button" role="switch" aria-checked={on} onClick={toggle} className="switch" data-testid="r2-forecast-toggle" /></label>
      {on && (fc.available ? <>
        <ul className="grid grid-cols-2 gap-2 text-center text-[12px]">
          <li className="rounded-xl bg-cream/5 p-2"><b className="block text-[14px] text-gold-soft">{fmtN(fc.class_a)}</b>Class A（{fmtPct(fc.class_a / f.class_a)}）</li>
          <li className="rounded-xl bg-cream/5 p-2"><b className="block text-[14px] text-gold-soft">{fmtN(fc.class_b)}</b>Class B（{fmtPct(fc.class_b / f.class_b)}）</li>
          <li className="rounded-xl bg-cream/5 p-2"><b className="block text-[14px] text-gold-soft">{fc.gb_month == null ? "未知" : gbm(fc.gb_month)}</b>計費儲存量</li>
          <li className="rounded-xl bg-cream/5 p-2"><b className="block text-[14px] text-gold-soft" data-testid="r2-forecast-cost">{fmtUsd(fc.cost.total)}</b>預計超額費用</li>
        </ul>
        <p className="text-[11px] text-mauve">估算：根據 {fc.basis.from} 至 {fc.basis.to} 共 {fc.basis.days} 日的官方數據{fc.basis.missing_days ? `（另有 ${fc.basis.missing_days} 日沒有數據）` : ""}。{fc.assumptions}{fc.stale ? " 數據可能已過時。" : ""}</p>
      </> : <p className="text-[12px] text-mauve" data-testid="r2-forecast-none">{fc.reason}</p>)}
    </section>
  );
}

function AppPurposes({ u }: { u: Usage }) {
  const [m, setM] = useState<"bytes" | "class_b" | "class_a">("bytes");
  const opOf = (k: string, op: string) => u.app.ops.filter((x) => x.purpose === k && x.op === op).reduce((s, x) => s + x.n, 0);
  const rows = u.purposes.map(([k, label]) => ({ k, name: label, n: m === "bytes" ? u.app.storage[k]?.bytes ?? 0 : opOf(k, m) }));
  const appOps = (op: string) => u.app.ops.filter((x) => x.op === op).reduce((s, x) => s + x.n, 0);
  return (
    <section className="frame space-y-2 p-4" data-testid="r2-app">
      <h3 className="font-serif text-[15px] text-gold-soft">AI Wardrobe 圖片及操作用途<span className="ml-1 text-[11px] font-sans text-mauve">App 自身估算｜{u.app.env === "production" ? "正式環境" : u.app.env === "preview" ? "預覽環境" : "測試環境"}｜{u.app.month}</span></h3>
      <Seg label="指標" testid="r2-app-metric" value={m} on={setM} opts={[["bytes", "容量"], ["class_b", "讀取 B"], ["class_a", "寫入 A"]]} />
      <Bars rows={rows.filter((r) => r.n > 0).sort((x, y) => y.n - x.n).map((r) => ({ name: r.name, n: r.n }))} format={m === "bytes" ? (x) => fmtSize(x) : (x) => fmtN(x)} />
      {rows.every((r) => r.n === 0) && <p className="text-[12px] text-mauve">本月暫時沒有這項記錄。</p>}
      <p className="text-[12px]">本月：讀取（B）{fmtN(appOps("class_b"))}、寫入／列出（A）{fmtN(appOps("class_a"))}、刪除（免費）{fmtN(appOps("free"))}｜縮圖補建讀取 {fmtN(u.app.thumbnail_backfill_reads)}</p>
      <details className="text-[12px]" data-testid="r2-app-table"><summary className="cursor-pointer text-mauve">技術表格</summary>
        <table className="mt-1 w-full text-[12px]">
          <thead className="text-mauve"><tr><th className="text-left font-normal">用途</th><th className="text-right font-normal">物件</th><th className="text-right font-normal">容量</th><th className="text-right font-normal">讀取 B</th><th className="text-right font-normal">寫入 A</th></tr></thead>
          <tbody>{u.purposes.map(([k, label]) => { const st = u.app.storage[k] ?? { objects: 0, bytes: 0 }; return <tr key={k} data-purpose={k}><td>{label}</td><td className="text-right tabular-nums">{fmtN(st.objects)}</td><td className="text-right tabular-nums">{fmtSize(st.bytes)}</td><td className="text-right tabular-nums">{fmtN(opOf(k, "class_b"))}</td><td className="text-right tabular-nums">{fmtN(opOf(k, "class_a"))}</td></tr>; })}</tbody>
        </table>
        <p className="mt-1 text-[11px] text-mauve">{u.app.note}{u.app.counting ? "" : " 統計資料表（migration 0012）尚未在這個環境建立，所以暫時沒有操作次數。"} App 估算不包括其他專案或 Cloudflare 內部操作，不能代替官方計費數據。</p>
      </details>
    </section>
  );
}

function LocalCache() {
  const [c, setC] = useState<Awaited<ReturnType<typeof imageCacheUsage>> | null>(null);
  useEffect(() => { imageCacheUsage().then(setC).catch(() => setC(null)); }, []);
  return (
    <section className="frame space-y-1 p-4 text-[12px]" data-testid="r2-local">
      <h3 className="font-serif text-[15px] text-gold-soft">本機快取統計<span className="ml-1 text-[11px] font-sans text-mauve">只計這部手機</span></h3>
      <ul className="grid grid-cols-3 gap-2 text-center">
        <li className="rounded-xl bg-cream/5 p-2"><b className="block text-[14px] text-gold-soft">{fmtN(localHitCount())}</b>高清快取命中<span className="block text-[10px] text-mauve">＝少了的 R2 讀取</span></li>
        <li className="rounded-xl bg-cream/5 p-2"><b className="block text-[14px] text-gold-soft">{c ? fmtN(c.thumbs.count) : "—"}</b>縮圖<span className="block text-[10px] text-mauve">{c ? fmtSize(c.thumbs.bytes) : ""}</span></li>
        <li className="rounded-xl bg-cream/5 p-2"><b className="block text-[14px] text-gold-soft">{c ? fmtN(c.hd.count) : "—"}</b>高清圖<span className="block text-[10px] text-mauve">{c ? fmtSize(c.hd.bytes) : ""}</span></li>
      </ul>
    </section>
  );
}

function Alerts({ u, onSaved }: { u: Usage; onSaved: () => void }) {
  const [warn, setWarn] = useState(u.alerts.warn.join(","));
  const [soft, setSoft] = useState(u.alerts.soft_limit);
  return (
    <section className="frame space-y-2 p-4" data-testid="r2-alerts">
      <h3 className="font-serif text-[15px] text-gold-soft">免費額度提醒及保護</h3>
      <label className="flex items-center gap-2">警告門檻（%）<input value={warn} onChange={(e) => setWarn(e.target.value)} className="field h-9 flex-1 rounded-full px-3 text-[14px]" data-testid="r2-warn" /></label>
      <label className="flex items-center gap-2">保守軟上限<input type="number" min={10} max={100} value={soft} onChange={(e) => setSoft(Number(e.target.value))} className="field h-9 w-20 rounded-full px-2 text-center text-[14px]" />%</label>
      <Button variant="ghost" onClick={async () => { try { await api("/api/r2/alerts", { method: "PUT", json: { warn: warn.split(/[,，\s]+/).map(Number).filter(Boolean), soft_limit: soft } }); toast("已保存提醒設定"); onSaved(); } catch (e) { toast((e as Error).message, "err"); } }}>保存</Button>
      <p className="text-[11px] text-mauve">背景保護：{u.background.allowed ? "正常" : "已暫停非必要背景工作"}{u.background.stale ? "（依據的官方數據可能已過時）" : ""}。達到軟上限時只暫停非必要背景工作；查看衣櫃、上傳及保存不受影響。這不是 Cloudflare 官方硬上限，不能保證零費用。</p>
    </section>
  );
}
