import { useEffect, useState } from "react";
import { api, AppSettings, formatDate } from "../api";
import { Button, ColumnSwitch, copyText, Field, inputCls, Link, PageTitle, setSettingsCache, Spinner, toast, useColumns, useSettings } from "../components/ui";
import { CopyBlock } from "./ImportCenter";
import { IconChart, IconChevronLeft, IconChevronRight, IconCloudUp, IconCrown, IconDownload, IconGrid, IconHome, IconImage, IconLayers, IconPalette, IconPencil, IconPerson, IconScissors, IconSparkle } from "../components/icons";
import { navigate } from "../router";
import { HomeEditor } from "../components/HomeEditor";
import { ThemeEditor } from "../components/ThemeEditor";
import { BgImage, HomeBgEditor } from "../components/HomeBackground";
import { useHomeLayout } from "../homeLayoutStore";
import { activeTheme } from "../../shared/theme";
import { localTheme } from "../theme";
import { ClearResult, checkImageUpdates, clearImageCaches, hdCacheLimit, imageCacheUsage, setHdCacheLimit } from "../imageCache";

import { BUILD } from "../build";

interface TokenRow {
  id: string;
  name: string;
  token_hint: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

type Row = { id: string; label: string; value?: string; Icon: typeof IconHome; to?: string };
/**
 * 設定（Phase 3.8A）：統一的分組列表。點擊各項才進入詳細設定，首頁不放大量表單及技術資訊。
 */
export default function Settings({ username, onLogout, section }: { username: string | null; onLogout: () => void; section?: string }) {
  const settings = useSettings();
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  useEffect(() => { api<{ tokens: TokenRow[] }>("/api/tokens").then((r) => setTokens(r.tokens)).catch(() => undefined); }, []);
  const theme = activeTheme(localTheme());
  const layout = useHomeLayout();
  const view = (() => { try { return localStorage.getItem("aw:wardrobe-view") === "detail" ? "詳細" : "圖片"; } catch { return "圖片"; } })();
  const cols = (() => { try { return Number(localStorage.getItem("aw:wardrobe-cols")) || 3; } catch { return 3; } })();
  const groups: [string, Row[]][] = [
    ["個人化", [
      { id: "home", label: "主頁佈局", value: `${layout.widgets.filter((w) => w.visible).length} 個元件`, Icon: IconHome },
      { id: "theme", label: "介面顏色", value: theme.name, Icon: IconPalette },
      { id: "background", label: "主頁背景", value: settings?.home_bg ? "已設定" : "未設定", Icon: IconImage },
      { id: "wardrobe", label: "衣櫃顯示方式", value: `${view}｜每排 ${cols} 件`, Icon: IconGrid },
    ]],
    ["衣櫃管理", [
      { id: "taxonomy", label: "分類及屬性管理", Icon: IconLayers, to: "/taxonomy" },
      { id: "setup", label: "衣服設定", Icon: IconScissors, to: "/dressing/setup" },
      { id: "assets", label: "角色素材", Icon: IconCrown, to: "/dressing/assets" },
      { id: "images", label: "圖片及上傳設定", value: "手動去背", Icon: IconCloudUp },
    ]],
    ["資料及儲存", [
      { id: "offline", label: "本機圖片快取", Icon: IconDownload },
      { id: "storage", label: "伺服器縮圖狀態", Icon: IconChart },
    ]],
    ["AI 及帳戶", [
      { id: "ai", label: "AI 連接器", value: `${tokens.filter((t) => !t.revoked_at).length} 個`, Icon: IconSparkle },
      { id: "ai-command", label: "AI 整理指令", value: settings?.ai_command_is_default === false ? "已自訂" : "預設", Icon: IconPencil },
      { id: "account", label: "帳戶設定", value: username ?? "", Icon: IconPerson },
    ]],
  ];
  if (section) {
    const row = groups.flatMap((g) => g[1]).find((r) => r.id === section) ?? (section === "about" ? { id: "about", label: "關於", Icon: IconSparkle } : null);
    return (
      <div data-testid={`settings-${section}`}>
        <div className="flex items-center gap-2 pb-3 pt-5">
          <button type="button" aria-label="返回設定" onClick={() => navigate("/settings")} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full text-[17px]"><IconChevronLeft /></button>
          <h1 className="font-serif text-[21px] font-bold tracking-[0.1em] text-gold-soft">{row?.label ?? "設定"}</h1>
        </div>
        {section === "home" && <>
          <button type="button" data-testid="home-edit-inplace" onClick={() => navigate("/?edit=home")} className="btn-jewel mb-3 h-11 w-full rounded-full text-[13.5px]">在主頁直接編輯（拖動真實元件）</button>
          <p className="mb-2 text-[11.5px] leading-snug text-mauve">以下是列表排序（進階／無障礙後備），與主頁編輯使用同一份布局及設定。</p>
          <HomeEditor layout={layout} inline onClose={() => navigate("/settings")} />
        </>}
        {section === "theme" && <ThemeEditor />}
        {section === "background" && <BackgroundSection />}
        {section === "wardrobe" && <WardrobeDisplay />}
        {section === "images" && <ImageSettings />}
        {section === "offline" && <LocalCache />}
        {section === "storage" && <ThumbnailStatus />}
        {section === "ai" && <Connectors tokens={tokens} reload={() => api<{ tokens: TokenRow[] }>("/api/tokens").then((r) => setTokens(r.tokens))} />}
        {section === "ai-command" && <AiCommandEditor />}
        {section === "account" && (
          <section className="frame p-4">
            <Field label="登入身份"><p className="text-[15px]">{username}</p></Field>
            <Button variant="ghost" className="mt-3" data-testid="logout" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); onLogout(); }}>登出</Button>
            <p className="mt-2 text-[11.5px] text-mauve">登出時會清除這部手機的私人資料快取及圖片快取。</p>
          </section>
        )}
        {section === "about" && <About />}
      </div>
    );
  }
  return (
    <div data-testid="settings-home">
      <PageTitle>設定</PageTitle>
      {groups.map(([title, rows]) => (
        <section key={title} className="mb-4" data-settings-group={title}>
          <h2 className="mb-1.5 px-1 text-[12px] tracking-[0.12em] text-mauve">{title}</h2>
          <ul className="frame divide-y divide-gold/15 overflow-hidden p-0">
            {rows.map((r) => (
              <li key={r.id}>
                <Link to={r.to ?? `/settings/${r.id}`} className="flex min-h-12 items-center gap-3 px-3.5 py-2.5" data-settings-row={r.id}>
                  <r.Icon className="shrink-0 text-[17px] text-gold-soft" />
                  <span className="min-w-0 flex-1 truncate text-[14px]">{r.label}</span>
                  {r.value && <span className="max-w-[45%] shrink-0 truncate text-[12px] text-mauve">{r.value}</span>}
                  <IconChevronRight className="shrink-0 text-[14px] text-mauve" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <Link to="/settings/about" className="block px-1 pb-2 text-center text-[11px] text-mauve" data-testid="app-version">AI Wardrobe · Phase {BUILD.phase}｜Build {BUILD.sha}{BUILD.built && <> · {new Date(BUILD.built).toLocaleString("zh-HK", { timeZone: "Asia/Hong_Kong" })}</>}</Link>
    </div>
  );
}

function About() {
  return <section className="frame p-4 text-[13px]"><p>AI Wardrobe · Phase {BUILD.phase}</p><p className="mt-1 text-mauve">Build：{BUILD.sha}{BUILD.built && <> · {new Date(BUILD.built).toLocaleString("zh-HK", { timeZone: "Asia/Hong_Kong" })}</>}</p></section>;
}

function BackgroundSection() {
  const settings = useSettings();
  const [open, setOpen] = useState(false);
  const bg = settings?.home_bg ?? null;
  return (
    <section className="frame p-4">
      {bg ? <BgImage src={bg.url} iw={bg.width} ih={bg.height} layout={bg} fade={false} /> : <p className="text-[13px] text-mauve">未有主頁背景。</p>}
      <div className="mt-3 flex gap-2"><Button onClick={() => setOpen(true)}>{bg ? "更換或調整背景" : "加入背景"}</Button></div>
      <p className="mt-2 text-[11.5px] text-mauve">比例、裁切位置、縮放在這裡調整；顯示或隱藏封面、衣櫃名稱、統計及文字陰影在「主頁佈局 › 背景封面」設定。</p>
      {open && <HomeBgEditor current={bg} onClose={() => setOpen(false)} />}
    </section>
  );
}

function WardrobeDisplay() {
  const [view, setView] = useState(() => { try { return localStorage.getItem("aw:wardrobe-view") === "detail" ? "detail" : "grid"; } catch { return "grid"; } });
  const [cols, setCols] = useColumns("aw:wardrobe-cols", 3);
  return (
    <section className="frame space-y-3 p-4 text-[13px]">
      <div className="flex items-center gap-2">顯示方式{(["grid", "detail"] as const).map((v) => <button key={v} type="button" aria-pressed={view === v} onClick={() => { setView(v); try { localStorage.setItem("aw:wardrobe-view", v); } catch { /* ignore */ } }} className={`h-8 rounded-full px-3 ${view === v ? "chip-on" : "chip"}`}>{v === "grid" ? "圖片" : "詳細"}</button>)}</div>
      <div className="flex items-center gap-2">每排<ColumnSwitch value={cols} onChange={setCols} /></div>
      <p className="text-[11.5px] text-mauve">也可以在衣櫃頁工具列的顯示設定隨時更改。</p>
    </section>
  );
}

function ImageSettings() {
  const [limit, setLimit] = useState(() => Math.round(hdCacheLimit() / 1048576));
  return (
    <section className="frame space-y-3 p-4 text-[13px]">
      <p>上傳時只保存原圖、縮圖及必要分析，不會自動去背。需要時在衣物詳情或上傳完成頁按「去背」，確認後才保存透明圖片，原圖永遠保留。也可以在衣櫃「批量修改」選取多件後批量去背。</p>
      <label className="flex items-center gap-2">高清圖片快取上限<input type="number" min={20} max={4000} value={limit} onChange={(e) => setLimit(Number(e.target.value) || 20)} className="field h-8 w-20 rounded-full px-2 text-center text-[14px]" />MB
        <Button variant="ghost" onClick={() => { setHdCacheLimit(limit * 1048576); toast("已更新高清快取上限"); }}>套用</Button></label>
      <p className="text-[11.5px] text-mauve">查看過的高清圖片會保存在這部手機，再次查看不用重新下載；超過上限時先清走長期未用的圖片。</p>
    </section>
  );
}

/**
 * 本機圖片快取（3.8A.2）：「清除本機圖片快取」（以前叫「修復圖片快取」，但實際是清除）及「檢查及更新圖片」分開。
 * 清除前顯示容量及影響；只影響這部手機，伺服器原圖、D1 縮圖、衣物、穿搭、角色資料、未同步修改及離線佇列不受影響。
 */
export function LocalCache() {
  const [u, setU] = useState<Awaited<ReturnType<typeof imageCacheUsage>> | null>(null);
  const [pick, setPick] = useState<"thumbs" | "hd" | "all" | null>(null);
  const [withPinned, setWithPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClearResult | null>(null);
  const load = () => imageCacheUsage().then(setU);
  useEffect(() => { void load(); }, []);
  const mb = (b: number) => (b / 1048576).toFixed(1) + " MB";
  const est = !u || !pick ? 0 : (pick !== "hd" ? u.thumbs.bytes : 0) + (pick !== "thumbs" ? u.hd.bytes : 0);
  async function run() {
    if (!pick) return;
    setBusy(true);
    try {
      const r = await clearImageCaches({ thumbs: pick !== "hd", hd: pick !== "thumbs", includePinned: withPinned });
      setResult(r); setPick(null); await load();
      toast(r.errors.length ? `部分未能清除：${r.errors[0]}` : `已清除 ${r.thumbs.count + r.hd.count} 張（${mb(r.thumbs.bytes + r.hd.bytes)}）`, r.errors.length ? "err" : "ok");
    } finally { setBusy(false); }
  }
  return (
    <section className="frame space-y-3 p-4 text-[13px]" data-testid="local-cache">
      {!u ? <Spinner /> : <div className="grid grid-cols-2 gap-2 text-center" data-testid="cache-usage" data-thumbs={u.thumbs.count} data-hd={u.hd.count}>
        <div className="rounded-xl bg-cream/5 p-2"><p className="font-serif text-[18px] text-gold-soft">{u.thumbs.count}</p><p className="text-[11px] text-mauve">縮圖｜{mb(u.thumbs.bytes)}</p></div>
        <div className="rounded-xl bg-cream/5 p-2"><p className="font-serif text-[18px] text-gold-soft">{u.hd.count}</p><p className="text-[11px] text-mauve">高清圖片｜{mb(u.hd.bytes)}</p></div>
      </div>}
      <div className="space-y-1.5">
        <Button variant="ghost" className="w-full" data-testid="cache-check" onClick={() => { void checkImageUpdates(); toast("會在顯示圖片時核對版本，只重新下載有改動的圖片"); }}>檢查及更新圖片</Button>
        <p className="text-[11px] text-mauve">只核對圖片版本及更新時間，只下載有改動的圖片；不會清除全部縮圖或高清圖。</p>
      </div>
      <div className="space-y-1.5 border-t border-gold/20 pt-3">
        <p className="text-gold-soft">清除本機圖片快取</p>
        <div className="flex flex-wrap gap-1.5">
          {([["thumbs", "清除縮圖"], ["hd", "清除高清圖片"], ["all", "清除全部圖片快取"]] as const).map(([k, l]) => <button key={k} type="button" data-clear={k} aria-pressed={pick === k} onClick={() => { setPick(k); setResult(null); }} className={`h-9 rounded-full px-3 text-[12.5px] ${pick === k ? "chip-on" : "chip"}`}>{l}</button>)}
        </div>
        {pick && u && (
          <div className="rounded-2xl bg-cream/5 p-3 text-[12px] leading-relaxed" data-testid="clear-confirm">
            <p>將清除約 <b data-testid="clear-estimate">{mb(est)}</b>。</p>
            <ul className="list-disc pl-4 text-mauve">
              <li>只影響這部手機；伺服器原圖（R2）、D1 縮圖、衣物及穿搭資料、角色資料不受影響。</li>
              <li>未同步的修改、未上傳的圖片及離線佇列不會被刪除。</li>
              <li>之後需要重新下載圖片（會產生少量 R2 讀取），離線時可能看不到圖片。</li>
            </ul>
            {pick !== "thumbs" && <label className="mt-1.5 flex items-center gap-2"><input type="checkbox" checked={withPinned} onChange={(e) => setWithPinned(e.target.checked)} data-testid="clear-pinned" />同時刪除已指定保留的離線高清圖（預設保留）</label>}
            <div className="mt-2 flex gap-2"><Button variant="ghost" onClick={() => setPick(null)} disabled={busy}>取消</Button><Button variant="danger" data-testid="clear-run" disabled={busy} onClick={() => void run()}>確認清除</Button></div>
          </div>
        )}
        {result && <p className="text-[12px]" role="status" data-testid="clear-result" data-errors={result.errors.length}>已清除縮圖 {result.thumbs.count} 張、高清圖 {result.hd.count} 張（{mb(result.thumbs.bytes + result.hd.bytes)}）{result.keptPinned ? `；保留指定離線圖 ${result.keptPinned} 張` : ""}{result.errors.length ? `；未能清除：${result.errors.join("、")}` : ""}</p>}
      </div>
    </section>
  );
}

function Connectors({ tokens, reload }: { tokens: TokenRow[]; reload: () => void }) {
  const [name, setName] = useState("ChatGPT");
  const [fresh, setFresh] = useState<{ name: string; url: string } | null>(null);
  async function create() {
    try {
      const r = await api<{ token: string; name: string }>("/api/tokens", { method: "POST", json: { name } });
      setFresh({ name: r.name, url: `${location.origin}/mcp/${r.token}` });
      reload();
    } catch (e) { toast((e as Error).message, "err"); }
  }
  const active = tokens.filter((t) => !t.revoked_at);
  return (
    <section className="frame pat-dots p-4">
      <p className="text-[13px] text-mauve">每個 AI 用一條獨立網址，方便日後個別停用。網址本身就是密碼，請勿分享。</p>
      <div className="mt-3 flex gap-2">
        <input className={`${inputCls} flex-1`} value={name} onChange={(e) => setName(e.target.value)} aria-label="連接名稱" />
        <Button onClick={create}>產生網址</Button>
      </div>
      {fresh && (
        <div className="mt-3">
          <p className="text-[13px] text-rose">「{fresh.name}」的 MCP 網址（只顯示一次）：</p>
          <CopyBlock text={fresh.url} />
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-[13px] text-rose/85">
            <li>ChatGPT：設定 → 應用程式與連接器 → 進階設定開啟開發者模式 → 建立連接器，貼上網址，驗證選「無」。</li>
            <li>Claude：設定 → 連接器 → 新增自訂連接器，貼上網址。</li>
            <li>在對話中啟用「AI Wardrobe」工具，然後上傳衣物相。</li>
          </ol>
        </div>
      )}
      {active.length > 0 && (
        <ul className="mt-4 space-y-2">
          {active.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 rounded-2xl bg-velvet px-3 py-2.5 text-[13px]">
              <div className="min-w-0">
                <div className="truncate font-medium">{t.name}　<span className="text-mauve">…{t.token_hint}</span></div>
                <div className="text-[12px] text-mauve">{t.last_used_at ? `最後使用 ${formatDate(t.last_used_at)}` : "未使用"}｜權限 {t.scopes}</div>
              </div>
              <button type="button" className="shrink-0 text-wine" onClick={async () => { if (!confirm(`停用「${t.name}」？使用這條網址的 AI 會即時失去存取權。`)) return; await api(`/api/tokens/${t.id}`, { method: "DELETE" }); toast("已停用"); reload(); }}>停用</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 「交給 AI 填寫」按鈕複製的指令：可自行修改寫法，或還原預設 */
function AiCommandEditor() {
  const settings = useSettings();
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settings && text === null) setText(settings.ai_command);
  }, [settings, text]);
  if (!settings || text === null) return null;
  const changed = text.trim() !== settings.ai_command;

  async function save(value: string) {
    setBusy(true);
    try {
      const next = await api<AppSettings>("/api/settings", { method: "PUT", json: { ai_command: value } });
      setSettingsCache(next);
      setText(next.ai_command);
      toast(next.ai_command_is_default ? "已還原預設指令" : "已儲存指令");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="frame mt-5 p-4">
      <h2 className="font-serif text-lg font-bold text-gold-soft">AI 指令</h2>
      <p className="mt-1 text-[13px] text-mauve">按「交給 AI 填寫」時會複製這段文字。可以改成你自己的寫法，例如加上「名稱用日文原名」「不用查品牌」。</p>
      <textarea className={`${inputCls} mt-3 min-h-52 text-[14px] leading-relaxed`} value={text} onChange={(e) => setText(e.target.value)} aria-label="AI 指令" maxLength={4000} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button disabled={busy || !changed || !text.trim()} onClick={() => save(text)}>
          {busy ? "儲存中…" : "儲存"}
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            const ok = await copyText(text);
            toast(ok ? "已複製" : "未能自動複製，請長按文字複製", ok ? "ok" : "err");
          }}
        >
          複製
        </Button>
        {!settings.ai_command_is_default && (
          <button
            type="button"
            disabled={busy}
            className="ml-auto text-[13px] text-amethyst-deep underline underline-offset-4"
            onClick={() => confirm("還原為預設指令？你修改過的寫法會被取代。") && save("")}
          >
            還原預設
          </button>
        )}
      </div>
    </section>
  );
}

/** 伺服器 D1 縮圖補建狀態（技術資料，Phase 3.8B 會改為 R2 用量監察頁） */
function ThumbnailStatus() {
  const [status,setStatus]=useState<any>(null);
  const load=()=>api<any>("/api/thumbnails/status").then(setStatus).catch(()=>{});
  useEffect(()=>{void load();},[]);
  if(!status)return null;
  return <section className="mb-5 rounded-2xl bg-head p-4 text-sm">
    <h2 className="font-serif text-lg text-gold-soft">圖片與離線縮圖</h2>
    <p className="mt-2">已建立 {status.storage.count} 張縮圖 · {(status.storage.bytes/1048576).toFixed(1)} MB</p>
    <p>待處理 {status.jobs.filter((j:any)=>j.state!=="failed").reduce((s:number,j:any)=>s+j.count,0)} 張 · 失敗 {status.jobs.find((j:any)=>j.state==="failed")?.count??0} 張</p>
    <p className="mt-1 text-xs text-mauve">今日補建讀取 {status.today.r2_reads??0}／{status.limits.r2_reads} 次；縮圖回應 {((status.today.response_bytes??0)/1048576).toFixed(1)} MB。保持 App 開啟時會分批繼續處理。</p>
    {status.recent_errors?.length>0&&<p className="mt-2 text-xs text-rose">最近補圖錯誤：{status.recent_errors[0].last_error}（可稍後重試）</p>}
    <button type="button" className="mt-2 underline" onClick={load}>更新進度</button>
    {status.failed.length>0&&<button type="button" className="ml-4 underline" onClick={async()=>{await api("/api/thumbnails/jobs/retry",{method:"POST"});load();}}>重試失敗縮圖</button>}
  </section>;
}
