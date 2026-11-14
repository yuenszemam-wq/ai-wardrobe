// Phase 3.8B：R2 用量及費用。官方數據（Cloudflare Analytics）與 AI Wardrobe 自身統計分開標示；取不到官方數據時不顯示虛構數字。
import { ReactNode, useEffect, useState } from "react";
import { api } from "../api";
import { localHitCount } from "../imageCache";
import { Button, Spinner, toast } from "./ui";

interface Usage {
  pricing: { checked_at: string; source: string; storage_class: string; free: { gb_month: number; class_a: number; class_b: number }; price: { gb_month: number; class_a_per_million: number; class_b_per_million: number }; egress: string };
  purposes: [string, string][];
  official: { available: boolean; reason?: string; missing?: string[]; message?: string; fetched_at?: string; delay_note?: string;
    account?: { class_a: number; class_b: number; free: number; storage_bytes: number | null; objects: number | null; gb_month_est: number | null; days: number };
    buckets?: Record<string, { class_a: number; class_b: number; storage_bytes: number | null; objects: number | null }> };
  app: { env: string; month: string; storage: Record<string, { objects: number; bytes: number }>; ops: { purpose: string; op: string; n: number }[]; counting: boolean; thumbnail_backfill_reads: number; note: string };
  alerts: { warn: number[]; soft_limit: number };
  free_use: { source: "official" | "app_estimate"; class_a: number; class_b: number; storage: number | null };
  cost: { storage: number | null; class_a: number; class_b: number; total: number } | null;
  background: { allowed: boolean; reason?: string };
}
const n = (x: number) => x.toLocaleString("en-US");
const size = (b: number | null | undefined) => (b == null ? "—" : b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(1) + " MB");
const usd = (x: number | null | undefined) => (x == null ? "—" : "US$" + x.toFixed(x < 1 ? 4 : 2));

export function R2Usage({ advanced }: { advanced?: ReactNode }) {
  const [u, setU] = useState<Usage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState("70,85,95");
  const [soft, setSoft] = useState(90);
  const load = async (refresh = false) => {
    setBusy(true);
    try { const r = await api<Usage>(`/api/r2/usage${refresh ? "?refresh=1" : ""}`); setU(r); setWarn(r.alerts.warn.join(",")); setSoft(r.alerts.soft_limit); setErr(null); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  if (!u) return err ? <p className="frame p-4 text-[13px]" role="alert">未能讀取用量：{err}</p> : <Spinner />;
  const o = u.official, a = o.account, f = u.pricing.free;
  const appOps = (op: string) => u.app.ops.filter((x) => x.op === op).reduce((s, x) => s + x.n, 0);
  const pct = (x: number | null) => (x == null ? null : Math.round(x * 1000) / 10);
  const highest = Math.max(u.free_use.class_a, u.free_use.class_b, u.free_use.storage ?? 0) * 100;
  const level = [...u.alerts.warn].reverse().find((w) => highest >= w);
  return (
    <div className="space-y-3 text-[13px]" data-testid="r2-usage" data-official={o.available ? "1" : "0"} data-reason={o.reason ?? ""}>
      {level != null && <p role="alert" data-status-color className="rounded-2xl bg-danger/30 px-3 py-2 text-[12.5px] text-danger-ink" data-testid="r2-warning">R2 免費額度已用約 {Math.round(highest)}%（警告門檻 {level}%）{u.free_use.source === "app_estimate" ? "；這是 App 自身統計的估算，未包括其他專案" : ""}。</p>}
      {!u.background.allowed && <p className="rounded-2xl bg-cream/5 px-3 py-2 text-[12px]" data-testid="r2-protect">{u.background.reason}。正常查看已存在的衣櫃及圖片、上傳及保存不受影響。</p>}

      <section className="frame space-y-2 p-4" data-testid="r2-official">
        <div className="flex items-center justify-between"><h3 className="font-serif text-[15px] text-gold-soft">Cloudflare 帳戶用量（官方）</h3><Button variant="ghost" disabled={busy} onClick={() => void load(true)}>重新整理</Button></div>
        {o.available && a ? <>
          <div className="grid grid-cols-2 gap-2 text-center">
            <Box label="目前儲存容量" value={size(a.storage_bytes)} sub={a.objects != null ? `${n(a.objects)} 個物件` : undefined} />
            <Box label="本月計費儲存量（估算）" value={a.gb_month_est == null ? "未提供" : a.gb_month_est.toFixed(3) + " GB-month"} sub={`免費 ${f.gb_month} GB-month｜${pct(u.free_use.storage) ?? "—"}%`} />
            <Box label="本月 Class A" value={n(a.class_a)} sub={`免費 ${n(f.class_a)}｜已用 ${pct(u.free_use.class_a)}%｜剩 ${n(Math.max(0, f.class_a - a.class_a))}`} />
            <Box label="本月 Class B" value={n(a.class_b)} sub={`免費 ${n(f.class_b)}｜已用 ${pct(u.free_use.class_b)}%｜剩 ${n(Math.max(0, f.class_b - a.class_b))}`} />
          </div>
          <p>預計費用（超出免費額度部分）：<b data-testid="r2-cost">{usd(u.cost?.total)}</b>（儲存 {usd(u.cost?.storage)}、Class A {usd(u.cost?.class_a)}、Class B {usd(u.cost?.class_b)}）</p>
          {o.buckets && <ul className="text-[12px] text-mauve">{Object.entries(o.buckets).map(([name, b]) => <li key={name}>{name}{name.includes("preview") ? "（預覽環境）" : name === "ai-wardrobe-images" ? "（正式環境）" : "（其他專案）"}：{size(b.storage_bytes)}｜A {n(b.class_a)}｜B {n(b.class_b)}</li>)}</ul>}
          <p className="text-[11px] text-mauve">最後更新：{o.fetched_at ? new Date(o.fetched_at).toLocaleString("zh-HK") : "—"}。{o.delay_note} GB-month 按官方每日儲存量計算，不是目前容量；最終以 Cloudflare 帳單為準。</p>
        </> : (
          <div className="rounded-2xl bg-cream/5 p-3 text-[12.5px]" data-testid="r2-official-missing">
            {o.reason === "missing_config" ? <>
              <p>未能讀取官方用量：Worker 缺少以下設定（不會顯示虛構數字）。</p>
              <ul className="mt-1 list-disc pl-4">{o.missing?.map((m) => <li key={m}>{m}</li>)}</ul>
              <ol className="mt-2 list-decimal space-y-0.5 pl-4 text-[12px] text-mauve">
                <li>Cloudflare Dashboard → 我的個人資料 → API Tokens → 建立自訂 Token：權限只選「Account › Account Analytics › Read」，帳戶資源選你的帳戶。</li>
                <li>Workers &amp; Pages → ai-wardrobe → 設定 → 變數及密碼：新增 Secret「CF_API_TOKEN」（貼上 Token）。帳戶 ID 已在設定檔內。</li>
                <li>重新部署後回到這一頁按「重新整理」。Token 只保存在 Worker，不會出現在 App 或 GitHub。</li>
              </ol>
            </> : <p>官方用量暫時無法取得：{o.message}</p>}
          </div>
        )}
        <p className="text-[11px] text-mauve">定價（{u.pricing.storage_class}，{u.pricing.checked_at} 核對）：儲存 US${u.pricing.price.gb_month}／GB-month、Class A US${u.pricing.price.class_a_per_million}／百萬次、Class B US${u.pricing.price.class_b_per_million}／百萬次；對外傳輸{u.pricing.egress}。免費額度：每月 {f.gb_month} GB-month、Class A {n(f.class_a)} 次、Class B {n(f.class_b)} 次，<b>整個 Cloudflare 帳戶共用</b>。<a className="underline" href={u.pricing.source} target="_blank" rel="noreferrer">官方定價</a></p>
      </section>

      <section className="frame space-y-2 p-4" data-testid="r2-app">
        <h3 className="font-serif text-[15px] text-gold-soft">AI Wardrobe 自身用量（{u.app.env === "production" ? "正式環境" : u.app.env === "preview" ? "預覽環境" : "測試環境"}｜{u.app.month}）</h3>
        <table className="w-full text-[12px]">
          <thead className="text-mauve"><tr><th className="text-left font-normal">用途</th><th className="text-right font-normal">物件</th><th className="text-right font-normal">容量</th><th className="text-right font-normal">讀取 B</th><th className="text-right font-normal">寫入 A</th></tr></thead>
          <tbody>{u.purposes.map(([k, label]) => { const st = u.app.storage[k] ?? { objects: 0, bytes: 0 }; const op = (o2: string) => u.app.ops.filter((x) => x.purpose === k && x.op === o2).reduce((s, x) => s + x.n, 0); return <tr key={k} data-purpose={k}><td>{label}</td><td className="text-right tabular-nums">{n(st.objects)}</td><td className="text-right tabular-nums">{size(st.bytes)}</td><td className="text-right tabular-nums">{n(op("class_b"))}</td><td className="text-right tabular-nums">{n(op("class_a"))}</td></tr>; })}</tbody>
        </table>
        <p className="text-[12px]">本月合計：讀取（Class B）{n(appOps("class_b"))} 次、寫入／列出（Class A）{n(appOps("class_a"))} 次、刪除（免費）{n(appOps("free"))} 次｜縮圖補建讀取 {n(u.app.thumbnail_backfill_reads)} 次｜這部手機的本機高清快取命中 {n(localHitCount())} 次（＝少了的 R2 讀取，只計這部手機）</p>
        <p className="text-[11px] text-mauve">{u.app.note}{u.app.counting ? "" : " 統計資料表（migration 0012）尚未在這個環境建立，所以暫時沒有操作次數。"} 這些是 App 估算，不包括其他專案或 Cloudflare 內部操作；費用請以官方數據為準。</p>
      </section>

      <section className="frame space-y-2 p-4" data-testid="r2-alerts">
        <h3 className="font-serif text-[15px] text-gold-soft">免費額度提醒及保護</h3>
        <label className="flex items-center gap-2">警告門檻（%）<input value={warn} onChange={(e) => setWarn(e.target.value)} className="field h-9 flex-1 rounded-full px-3 text-[14px]" data-testid="r2-warn" /></label>
        <label className="flex items-center gap-2">保守軟上限<input type="number" min={10} max={100} value={soft} onChange={(e) => setSoft(Number(e.target.value))} className="field h-9 w-20 rounded-full px-2 text-center text-[14px]" />%</label>
        <Button variant="ghost" onClick={async () => { try { await api("/api/r2/alerts", { method: "PUT", json: { warn: warn.split(/[,，\s]+/).map(Number).filter(Boolean), soft_limit: soft } }); toast("已保存提醒設定"); void load(); } catch (e) { toast((e as Error).message, "err"); } }}>保存</Button>
        <p className="text-[11px] text-mauve">達到軟上限時，只暫停非必要背景工作（伺服器縮圖補建、批量離線下載會先提示）；查看衣櫃、上傳及保存資料不受影響。這不是 Cloudflare 的官方硬上限：數據延遲、其他專案共用額度或並行操作都可能令實際用量更高，所以不能保證零費用。</p>
      </section>
      {advanced && <details className="frame p-4" data-testid="r2-advanced"><summary className="cursor-pointer text-gold-soft">進階技術資訊：伺服器縮圖狀態</summary><div className="mt-2">{advanced}</div></details>}
    </div>
  );
}
function Box({ label, value, sub }: { label: string; value: string; sub?: string }) { return <div className="rounded-xl bg-cream/5 p-2"><p className="font-serif text-[16px] text-gold-soft">{value}</p><p className="text-[10.5px] text-mauve">{label}</p>{sub && <p className="text-[10px] text-mauve">{sub}</p>}</div>; }
