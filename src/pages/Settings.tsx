import { useEffect, useState } from "react";
import { api, Garment, formatBytes, formatDate, uploadImage } from "../api";
import { Button, Field, inputCls, Link, PageTitle, toast } from "../components/ui";
import { makeThumbnail } from "../imageProcessing";
import { CopyBlock } from "./ImportCenter";

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
  const [usage, setUsage] = useState<{ day: string; name: string | null; actor: string; calls: number; upload_bytes: number }[]>([]);
  const [maint, setMaint] = useState("");

  const load = () => {
    api<{ tokens: TokenRow[] }>("/api/tokens").then((r) => setTokens(r.tokens));
    api<{ usage: typeof usage }>("/api/usage").then((r) => setUsage(r.usage.filter((u) => u.actor !== "login_fail").slice(0, 10)));
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

  async function backfillThumbs() {
    setMaint("檢查中…");
    const r = await api<{ garments: Garment[] }>("/api/garments?limit=200&status=all");
    const todo = r.garments.filter((g) => g.primary_image_id && !g.thumb_image_id);
    let n = 0;
    for (const g of todo) {
      try {
        setMaint(`正在產生縮圖 ${n + 1}/${todo.length}`);
        const blob = await (await fetch(`/api/images/${g.primary_image_id}`, { credentials: "same-origin" })).blob();
        const thumb = await makeThumbnail(blob);
        await uploadImage("/api/images/upload", { garment_id: g.id, image_type: "thumbnail", derived_from: g.primary_image_id! }, thumb, "thumb.webp");
        n++;
      } catch {
        /* 繼續處理下一件 */
      }
    }
    setMaint(todo.length ? `已為 ${n} 件衣物產生縮圖` : "所有衣物已有縮圖");
  }

  async function orphans(del: boolean) {
    const r = await api<{ scanned: number; orphans: number; deleted: number }>("/api/maintenance/orphans", { method: "POST", json: { delete: del } });
    setMaint(del ? `已刪除 ${r.deleted} 個孤兒檔案` : `R2 共 ${r.scanned} 個檔案，其中 ${r.orphans} 個沒有資料庫記錄`);
  }

  const active = tokens.filter((t) => !t.revoked_at);

  return (
    <div>
      <PageTitle>設定</PageTitle>

      <Link to="/taxonomy" className="mb-4 flex items-center justify-between rounded-3xl bg-white px-4 py-4 ring-1 ring-ink/5">
        <span>
          <span className="block font-serif text-lg font-bold">分類管理</span>
          <span className="block text-[13px] text-mauve">主分類、子分類、屬性及選項：自由增加、改名、刪除、排序</span>
        </span>
        <span className="text-mauve">›</span>
      </Link>

      <section className="rounded-3xl bg-ink p-4 text-rose">
        <h2 className="font-serif text-lg font-bold">連接 ChatGPT／Claude</h2>
        <p className="mt-1 text-[13px] text-rose/80">
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

      <section className="mt-6">
        <h2 className="font-serif text-lg font-bold">AI 使用量</h2>
        <p className="mt-1 text-[13px] text-mauve">每條連接每日上限 3,000 次呼叫及 800 MB 上傳，防止意外大量使用。</p>
        {usage.length === 0 ? (
          <p className="mt-2 text-sm text-mauve">暫時未有紀錄。</p>
        ) : (
          <table className="mt-2 w-full text-left text-[13px]">
            <thead className="text-mauve">
              <tr><th className="py-1 font-normal">日期</th><th className="font-normal">連接</th><th className="font-normal">呼叫</th><th className="font-normal">上傳</th></tr>
            </thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.day + u.actor} className="border-t border-ink/5">
                  <td className="py-1.5">{u.day.slice(5)}</td>
                  <td className="truncate">{u.name || u.actor}</td>
                  <td>{u.calls}</td>
                  <td>{formatBytes(u.upload_bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-6">
        <h2 className="font-serif text-lg font-bold">維護</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="ghost" onClick={backfillThumbs}>補回缺少的縮圖</Button>
          <Button variant="ghost" onClick={() => orphans(false)}>檢查孤兒檔案</Button>
          <Button variant="danger" onClick={() => confirm("刪除 R2 中沒有資料庫記錄、超過 1 小時的檔案？") && orphans(true)}>清理孤兒檔案</Button>
        </div>
        {maint && <p className="mt-2 text-[13px] text-mauve">{maint}</p>}
      </section>

      <section className="mt-6">
        <h2 className="font-serif text-lg font-bold">帳戶</h2>
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
