import { useEffect, useState } from "react";
import { api, AppSettings, formatDate } from "../api";
import { Button, copyText, Field, inputCls, Link, PageTitle, setSettingsCache, toast, useSettings } from "../components/ui";
import { CopyBlock } from "./ImportCenter";

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

export default function Settings({ username, onLogout }: { username: string | null; onLogout: () => void }) {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [name, setName] = useState("ChatGPT");
  const [fresh, setFresh] = useState<{ name: string; url: string } | null>(null);

  const load = () => {
    api<{ tokens: TokenRow[] }>("/api/tokens").then((r) => setTokens(r.tokens));
  };
  useEffect(load, []);

  async function create() {
    try {
      const r = await api<{ token: string; name: string }>("/api/tokens", { method: "POST", json: { name } });
      setFresh({ name: r.name, url: `${location.origin}/mcp/${r.token}` });
      load();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  }

  const active = tokens.filter((t) => !t.revoked_at);

  return (
    <div>
      <PageTitle>設定</PageTitle>
      <p data-testid="app-version" className="mb-4 text-xs text-mauve">AI Wardrobe · Phase {BUILD.phase}<br/>Build：{BUILD.sha}{BUILD.built && <> · {new Date(BUILD.built).toLocaleString("zh-HK", {timeZone:"Asia/Hong_Kong"})}</>}</p>
      <ThumbnailStatus/>

      <Link to="/taxonomy" className="paper mb-5 flex items-center justify-between px-4 py-4">
        <span>
          <span className="block font-serif text-lg font-bold">分類管理</span>
          <span className="block text-[13px] text-mauve">主分類、子分類、屬性及選項：自由增加、改名、刪除、排序</span>
        </span>
        <span className="text-mauve">›</span>
      </Link>

      <section className="frame pat-dots p-4">
        <h2 className="font-serif text-lg font-bold text-gold-soft">連接 ChatGPT／Claude</h2>
        <p className="mt-1 text-[13px] text-mauve">
          每個 AI 用一條獨立網址，方便日後個別停用。網址本身就是密碼，請勿分享。
        </p>
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
                  <div className="text-[12px] text-mauve">
                    {t.last_used_at ? `最後使用 ${formatDate(t.last_used_at)}` : "未使用"}｜權限 {t.scopes}
                  </div>
                </div>
                <button
                  type="button"
                  className="shrink-0 text-wine"
                  onClick={async () => {
                    if (!confirm(`停用「${t.name}」？使用這條網址的 AI 會即時失去存取權。`)) return;
                    await api(`/api/tokens/${t.id}`, { method: "DELETE" });
                    toast("已停用");
                    load();
                  }}
                >
                  停用
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AiCommandEditor />

      <section className="mt-7">
        <h2 className="font-serif text-lg font-bold text-gold-soft">帳戶</h2>
        <Field label="登入身份">
          <p className="text-[15px]">{username}</p>
        </Field>
        <Button
          variant="ghost"
          className="mt-3"
          onClick={async () => {
            await api("/api/auth/logout", { method: "POST" });
            onLogout();
          }}
        >
          登出
        </Button>
      </section>
    </div>
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

function ThumbnailStatus() {
  const [status,setStatus]=useState<any>(null);
  const load=()=>api<any>("/api/thumbnails/status").then(setStatus).catch(()=>{});
  useEffect(()=>{void load();},[]);
  if(!status)return null;
  return <section className="mb-5 rounded-2xl bg-ink p-4 text-sm">
    <h2 className="font-serif text-lg text-gold-soft">圖片與離線縮圖</h2>
    <p className="mt-2">已建立 {status.storage.count} 張縮圖 · {(status.storage.bytes/1048576).toFixed(1)} MB</p>
    <p>待處理 {status.jobs.filter((j:any)=>j.state!=="failed").reduce((s:number,j:any)=>s+j.count,0)} 張 · 失敗 {status.jobs.find((j:any)=>j.state==="failed")?.count??0} 張</p>
    <p className="mt-1 text-xs text-mauve">今日補建讀取 {status.today.r2_reads??0}／{status.limits.r2_reads} 次；縮圖回應 {((status.today.response_bytes??0)/1048576).toFixed(1)} MB。保持 App 開啟時會分批繼續處理。</p>
    {status.recent_errors?.length>0&&<p className="mt-2 text-xs text-rose">最近補圖錯誤：{status.recent_errors[0].last_error}（可稍後重試）</p>}
    <button type="button" className="mt-2 underline" onClick={load}>更新進度</button>
    {status.failed.length>0&&<button type="button" className="ml-4 underline" onClick={async()=>{await api("/api/thumbnails/jobs/retry",{method:"POST"});load();}}>重試失敗縮圖</button>}
  </section>;
}
