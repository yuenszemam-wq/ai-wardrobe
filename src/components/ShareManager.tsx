/**
 * Phase 3.9B.1：衣櫃分享管理（設定 › 衣櫃分享）。
 * 建立唯讀連結：選擇公開哪些衣物（或公開全部再排除）、公開哪些欄位、是否公開分析、到期日；可撤銷、重新產生（舊連結即時失效）及刪除。
 * 連結只在建立／重新產生時顯示一次（伺服器只保存雜湊）。
 */
import { useEffect, useMemo, useState } from "react";
import { api, displayName, Garment } from "../api";
import { loadFullList } from "../wardrobeList";
import { Button, Sheet, Spinner, toast } from "./ui";

const FIELDS: [string, string, boolean][] = [["name", "名稱", true], ["category", "分類", true], ["subcategory", "子分類", true], ["brand", "品牌", true], ["colors", "顏色", true], ["style", "風格", true], ["season", "季節", true], ["pattern", "圖案", false], ["transparent_image", "去背高清圖", true], ["price", "價格", false], ["wear", "穿著次數", false], ["attributes", "其他屬性", false], ["notes", "備註", false]];
interface Share { id: string; title: string; message: string | null; scope: "selected" | "all"; fields: string[]; options: { analytics: boolean }; expires_at: string | null; revoked_at: string | null; active: boolean; item_count: number; view_count: number; last_viewed_at: string | null; created_at: string; garment_ids?: string[] }

export function ShareManager() {
  const [list, setList] = useState<Share[] | null>(null);
  const [edit, setEdit] = useState<Share | "new" | null>(null);
  const [link, setLink] = useState<{ url: string; title: string } | null>(null);
  const load = () => api<{ shares: Share[] }>("/api/shares").then((r) => setList(r.shares)).catch((e) => { toast((e as Error).message, "err"); setList([]); });
  useEffect(() => { void load(); }, []);
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast(msg); await load(); } catch (e) { toast((e as Error).message, "err"); } };
  return (
    <div className="space-y-3 text-[13px]" data-testid="share-manager">
      <p className="text-[12px] text-mauve">建立唯讀連結給朋友瀏覽你選擇公開的衣物。預設不公開價格、備註、穿著次數及原始相片；朋友不需要登入，亦不能修改或下載你的私人資料。撤銷後連結立即失效。</p>
      <Button className="w-full" onClick={() => setEdit("new")} data-testid="share-new">＋ 建立分享連結</Button>
      {!list ? <Spinner /> : !list.length ? <p className="py-4 text-center text-mauve">仍未有分享連結</p> : list.map((s) => (
        <div key={s.id} className="paper space-y-1.5 p-3" data-share={s.id} data-active={s.active ? "1" : "0"}>
          <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-serif text-[15px] font-bold">{s.title}</span><span className={`rounded-full px-2 py-0.5 text-[11px] ${s.active ? "chip-on" : "chip opacity-70"}`}>{s.revoked_at ? "已撤銷" : s.active ? "分享中" : "已到期"}</span></div>
          <p className="text-[11.5px] text-mauve">{s.scope === "all" ? `全部衣物（排除 ${s.item_count} 件）` : `${s.item_count} 件衣物`}・{s.fields.length} 個欄位{s.options.analytics ? "・公開分析" : ""}・瀏覽 {s.view_count} 次{s.expires_at ? `・${new Date(s.expires_at).toLocaleDateString("zh-HK")} 到期` : ""}</p>
          <div className="flex flex-wrap gap-1">
            <Button variant="ghost" onClick={async () => { try { setEdit(await api<Share>(`/api/shares/${s.id}`)); } catch (e) { toast((e as Error).message, "err"); } }} data-share-action="edit">編輯</Button>
            <Button variant="ghost" onClick={() => void act(async () => { if (!confirm(s.active ? "重新產生連結？舊連結會立即失效。" : "重新產生並重新啟用這條連結？")) throw new Error("已取消"); const r = await api<{ url: string }>(`/api/shares/${s.id}/rotate`, { method: "POST" }); setLink({ url: r.url, title: s.title }); }, "已產生新連結")} data-share-action="rotate">{s.active ? "重新產生連結" : "重新啟用"}</Button>
            {s.active && <Button variant="ghost" className="text-wine" onClick={() => void act(async () => { if (!confirm("撤銷這條分享連結？朋友會立即無法再瀏覽。")) throw new Error("已取消"); await api(`/api/shares/${s.id}/revoke`, { method: "POST" }); }, "已撤銷")} data-share-action="revoke">撤銷</Button>}
            <Button variant="ghost" className="text-wine" onClick={() => void act(async () => { if (!confirm("刪除這條分享連結的設定？")) throw new Error("已取消"); await api(`/api/shares/${s.id}`, { method: "DELETE" }); }, "已刪除")} data-share-action="delete">刪除</Button>
          </div>
        </div>
      ))}
      {edit && <ShareEditor value={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={(r) => { setEdit(null); if (r) setLink(r); void load(); }} />}
      {link && <Sheet title="分享連結" onClose={() => setLink(null)}>
        <div className="space-y-2" data-testid="share-link">
          <p className="text-[12px] text-mauve">這條連結只會顯示一次（為安全起見伺服器只保存雜湊）。之後需要時可以「重新產生連結」，舊連結會失效。</p>
          <input readOnly value={link.url} className="field h-10 w-full rounded-full px-3 text-[13px]" data-testid="share-url" onFocus={(e) => e.currentTarget.select()} />
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={async () => { try { await navigator.clipboard.writeText(link.url); toast("已複製連結"); } catch { toast("未能複製，請長按連結自行複製", "err"); } }}>複製連結</Button>
            <Button variant="ghost" onClick={async () => { if (navigator.share) await navigator.share({ title: link.title, url: link.url }).catch(() => undefined); else window.open(link.url, "_blank"); }}>分享／開啟</Button>
          </div>
        </div>
      </Sheet>}
    </div>
  );
}

function ShareEditor({ value, onClose, onSaved }: { value: Share | null; onClose: () => void; onSaved: (link: { url: string; title: string } | null) => void }) {
  const [title, setTitle] = useState(value?.title ?? "我的衣櫃");
  const [message, setMessage] = useState(value?.message ?? "");
  const [scope, setScope] = useState<"selected" | "all">(value?.scope ?? "selected");
  const [fields, setFields] = useState<Set<string>>(new Set(value?.fields ?? FIELDS.filter((f) => f[2]).map((f) => f[0])));
  const [analytics, setAnalytics] = useState(value?.options.analytics ?? true);
  const [days, setDays] = useState<string>(value?.expires_at ? "keep" : "0");
  const [picked, setPicked] = useState<Set<string>>(new Set(value?.garment_ids ?? []));
  const [all, setAll] = useState<Garment[] | null>(null);
  const [cat, setCat] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadFullList(new URLSearchParams()).then(setAll).catch(() => setAll([])); }, []);
  const cats = useMemo(() => [...new Set((all ?? []).map((g) => g.category).filter((x): x is string => !!x))], [all]);
  const shown = (all ?? []).filter((g) => !cat || g.category === cat);
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  async function save() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { title, message, scope, fields: [...fields], options: { analytics }, garment_ids: [...picked] };
      if (days !== "keep") body.expires_at = days === "0" ? null : new Date(Date.now() + Number(days) * 86400_000).toISOString();
      if (value) { await api(`/api/shares/${value.id}`, { method: "PATCH", json: body }); toast("已更新分享設定"); onSaved(null); }
      else { const r = await api<{ url: string }>("/api/shares", { method: "POST", json: body }); onSaved({ url: r.url, title }); }
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  }
  return (
    <Sheet title={value ? "編輯分享" : "建立分享連結"} onClose={onClose}>
      <div className="space-y-2.5 text-[12.5px]" data-testid="share-editor">
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} placeholder="標題" className="field h-10 w-full rounded-full px-3 text-[16px]" data-testid="share-title" />
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={300} rows={2} placeholder="給朋友的說明（可選）" className="field w-full rounded-2xl px-3 py-2 text-[16px]" />
        <div className="seg" role="radiogroup" aria-label="公開範圍"><button type="button" aria-selected={scope === "selected"} onClick={() => setScope("selected")} data-scope="selected">只公開選擇的衣物</button><button type="button" aria-selected={scope === "all"} onClick={() => setScope("all")} data-scope="all">全部（可排除）</button></div>
        <p className="text-[11px] text-mauve">{scope === "selected" ? `已選擇 ${picked.size} 件公開` : `已排除 ${picked.size} 件`}；封存的衣物永遠不會公開。</p>
        {!all ? <Spinner /> : <>
          <div className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto px-1">{["", ...cats].map((c) => <button key={c || "all"} type="button" aria-pressed={cat === c} onClick={() => setCat(c)} className={`h-7 shrink-0 rounded-full px-2.5 text-[12px] ${cat === c ? "chip-on" : "chip"}`}>{c || "全部"}</button>)}</div>
          <div className="flex gap-1"><Button variant="ghost" onClick={() => setPicked((s) => new Set([...s, ...shown.map((g) => g.id)]))} data-testid="share-pick-all">全選這頁</Button><Button variant="ghost" onClick={() => setPicked((s) => { const n = new Set(s); shown.forEach((g) => n.delete(g.id)); return n; })}>取消這頁</Button></div>
          <div className="grid max-h-[32vh] grid-cols-4 gap-1.5 overflow-y-auto" data-testid="share-picker">
            {shown.map((g) => <button key={g.id} type="button" aria-pressed={picked.has(g.id)} onClick={() => toggle(g.id)} className={`relative text-center text-[10px] ${picked.has(g.id) ? "" : "opacity-60"}`} data-pick={g.id}>
              <span className={`arch-base block aspect-[3/4] overflow-hidden rounded-xl ${picked.has(g.id) ? "ring-2 ring-[var(--aw-focus)]" : ""}`}>{g.thumb_image_id && <img src={`/api/thumbnails/${g.thumb_image_id}`} alt="" loading="lazy" className="h-full w-full object-contain" />}</span>
              <span className="block truncate">{displayName(g)}</span>
              {picked.has(g.id) && <span className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-[var(--aw-primary)] text-[10px] text-[var(--aw-on-primary)]">{scope === "all" ? "✕" : "✓"}</span>}
            </button>)}
          </div>
        </>}
        <p className="pt-1 text-[12px] text-mauve">公開欄位</p>
        <div className="flex flex-wrap gap-1" data-testid="share-fields">{FIELDS.map(([k, l]) => <button key={k} type="button" aria-pressed={fields.has(k)} onClick={() => setFields((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })} className={`h-7 rounded-full px-2.5 ${fields.has(k) ? "chip-on" : "chip"}`} data-field={k}>{l}</button>)}</div>
        <label className="flex items-center gap-2"><input type="checkbox" checked={analytics} onChange={(e) => setAnalytics(e.target.checked)} data-testid="share-analytics" />公開分析（只計算公開的衣物；價格及穿著次數只在公開該欄位時計算）</label>
        <label className="flex items-center gap-2"><span className="text-mauve">到期</span><select value={days} onChange={(e) => setDays(e.target.value)} className="field h-9 rounded-full px-2 text-[14px]">{value?.expires_at && <option value="keep">維持原本</option>}<option value="0">不設到期</option><option value="7">7 日</option><option value="30">30 日</option><option value="90">90 日</option></select></label>
        <Button className="w-full" disabled={busy || (scope === "selected" && !picked.size)} onClick={() => void save()} data-testid="share-save">{busy ? "保存中…" : value ? "保存設定" : "建立連結"}</Button>
      </div>
    </Sheet>
  );
}
