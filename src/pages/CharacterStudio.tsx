// 角色素材工作室（Phase 3.6C）：身體、頭部、髮型、姿勢的獨立管理介面（不放在換裝頁的外貌選單內）。
// 列表只讀 D1 縮圖及設定；高清身體部件只在編輯器內按需讀取。
import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { BUILTIN_HAIRS, BUILTIN_HEADS, DollAsset, HAIR_CATS, HAIR_CAT_BONE, HAIR_CAT_LABEL, HAIR_CAT_LAYER, HairCat, HairConfig, hairCatOf, hairPartName, placeHairPart, refUrl } from "../../shared/avatarV2";
import { api } from "../api";
import { IconChevronLeft } from "../components/icons";
import { Spinner, toast } from "../components/ui";
import { prepareAsset } from "../doll/content";
import { BUILTIN_THUMB, userAsset } from "../doll/model";
import { ModelSummary, listModels } from "../doll/models";
import { exportModelPackage, importModelPackage } from "../doll/modelPackage";
import { SavedPose, fetchPoses } from "../doll/PoseLibrary";
import { navigate } from "../router";

type Tab = "body" | "head" | "hair" | "pose";
const TABS: [Tab, string][] = [["body", "身體"], ["head", "頭部"], ["hair", "髮型"], ["pose", "姿勢"]];
const pill = (on: boolean) => `shrink-0 rounded-full px-3.5 py-1.5 text-[13px] ${on ? "chip-on" : "chip"}`;
const Card = ({ children, className = "" }: { children: ReactNode; className?: string }) => <div className={`frame relative px-2.5 py-2 ${className}`}>{children}</div>;
const Thumb = ({ src, label }: { src: string | null | undefined; label: string }) => (
  <span className="relative block h-20 w-16 shrink-0 overflow-hidden rounded-xl bg-cream/85">{src ? <img src={src} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain p-1" /> : <span className="absolute inset-0 grid place-items-center text-[12px] text-mauve">{label.slice(0, 2)}</span>}</span>
);
const Act = ({ children, onClick, danger, disabled, testid }: { children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; testid?: string }) => (
  <button type="button" data-testid={testid} disabled={disabled} onClick={onClick} className={`rounded-full px-2.5 py-1 text-[11.5px] disabled:opacity-40 ${danger ? "bg-[#a12c4b]/35 text-[#ffd3df]" : "chip"}`}>{children}</button>
);

export default function CharacterStudio() {
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get("tab") as Tab) || "body");
  const [busy, setBusy] = useState(false);
  useEffect(() => { try { history.replaceState(null, "", "/dressing/assets" + (tab === "body" ? "" : "?tab=" + tab)); } catch { /* 忽略 */ } }, [tab]);
  const run = async (fn: () => Promise<unknown>, done?: string) => { setBusy(true); try { await fn(); if (done) toast(done); return true; } catch (e) { toast((e as Error).message, "err"); return false; } finally { setBusy(false); } };
  return (
    <div data-testid="character-studio" className="pb-8">
      <div className="flex items-center gap-2 pb-2 pt-5">
        <button type="button" aria-label="返回穿搭工作室" onClick={() => navigate("/outfits")} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full text-[17px]"><IconChevronLeft /></button>
        <h1 className="flex-1 font-serif text-[21px] font-bold tracking-[0.12em] text-gold-soft">角色素材</h1>
        <button type="button" onClick={() => navigate("/dressing")} className="chip rounded-full px-3 py-1.5 text-[12px]">去換裝</button>
      </div>
      <div className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-3" role="tablist">{TABS.map(([t, l]) => <button key={t} type="button" role="tab" data-studio-tab={t} aria-selected={tab === t} onClick={() => setTab(t)} className={pill(tab === t)}>{l}</button>)}</div>
      {tab === "body" && <Bodies busy={busy} run={run} />}
      {tab === "head" && <Heads busy={busy} run={run} />}
      {tab === "hair" && <Hairs busy={busy} run={run} />}
      {tab === "pose" && <Poses busy={busy} run={run} />}
    </div>
  );
}
type Run = (fn: () => Promise<unknown>, done?: string) => Promise<boolean>;

// ───── 身體 ─────
function Bodies({ busy, run }: { busy: boolean; run: Run }) {
  const [models, setModels] = useState<ModelSummary[] | null>(null);
  const [def, setDef] = useState("avatar_v2");
  const [archived, setArchived] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const load = () => listModels(true).then((r) => { setModels(r.models); setDef(r.default_model); }).catch((e) => toast((e as Error).message, "err"));
  useEffect(() => { void load(); }, []);
  const create = (from: string, name?: string) => run(async () => { const m = await api<{ id: string }>("/api/doll/models", { method: "POST", json: { from, ...(name ? { name } : {}) } }); navigate(`/dressing/models/${m.id}`); }, "已建立新身體（與來源相同，可以開始替換部件）");
  const shown = (models ?? []).filter((m) => archived || m.status !== "archived");
  return (
    <div data-testid="studio-bodies">
      <div className="flex flex-wrap gap-1.5 pb-2">
        <button type="button" data-testid="body-new" disabled={busy} onClick={() => { const name = prompt("新身體名稱", "我的身體")?.trim(); if (name) void create("avatar_v2", name); }} className="btn-jewel rounded-full px-3.5 py-1.5 text-[13px]">新增身體（複製 Avatar V2）</button>
        <button type="button" disabled={busy} onClick={() => file.current?.click()} className="chip rounded-full px-3 py-1.5 text-[12.5px]">匯入角色套件（ZIP）</button>
        <label className="ml-auto flex items-center gap-1.5 text-[12px] text-mauve"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />顯示已封存</label>
      </div>
      <p className="pb-2 text-[11.5px] leading-snug text-mauve">自訂身體沿用 Avatar V2 的骨架命名及 1200×1800 畫布，可以替換個別身體部件、調整關節及活動範圍。每次保存是一個新版本；已保存的造型繼續使用保存時的版本。</p>
      {!models ? <div className="py-10"><Spinner /></div> : (
        <ul className="space-y-2">
          {shown.map((m) => (
            <li key={m.id}>
              <Card className={m.status === "archived" ? "opacity-60" : ""}>
                <div className="flex gap-2.5" data-body-card={m.id}>
                  <Thumb src={m.thumb} label={m.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5"><span className="truncate text-[14px] font-medium">{m.name}</span>{def === m.id && <span className="rounded-full bg-gold/25 px-1.5 text-[10px] leading-[17px] text-gold-soft">預設</span>}{m.status === "archived" && <span className="rounded-full bg-white/10 px-1.5 text-[10px] leading-[17px]">已封存</span>}</div>
                    <div className="text-[10.5px] text-mauve">{m.builtin ? "內置身體（不可修改，可以複製）" : `第 ${m.revision} 版｜${m.looks} 個造型｜${m.templates} 件衣服已設定`}</div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {!m.builtin && m.status !== "archived" && <Act testid="body-edit" onClick={() => navigate(`/dressing/models/${m.id}`)}>編輯身體</Act>}
                      <Act disabled={busy} onClick={() => { const name = prompt("新身體名稱", m.name + " 副本")?.trim(); if (name) void create(m.id, name); }}>複製</Act>
                      {!m.builtin && <Act disabled={busy} onClick={() => { const name = prompt("新名稱", m.name)?.trim(); if (name) void run(() => api(`/api/doll/models/${m.id}`, { method: "PATCH", json: { name } }).then(load), "已改名"); }}>改名</Act>}
                      {def !== m.id && m.status !== "archived" && <Act disabled={busy} onClick={() => void run(() => api("/api/doll/models/default", { method: "PUT", json: { id: m.id } }).then(load), "已設為新造型的預設身體")}>設為預設</Act>}
                      <Act onClick={() => navigate(`/dressing/setup${m.builtin ? "" : "?model=" + m.id}`)}>衣服設定</Act>
                      {!m.builtin && <Act disabled={busy} onClick={() => void run(() => exportModelPackage(m.id))}>匯出</Act>}
                      {!m.builtin && <Act disabled={busy} onClick={() => void run(() => api(`/api/doll/models/${m.id}`, { method: "PATCH", json: { status: m.status === "archived" ? "active" : "archived" } }).then(load), m.status === "archived" ? "已恢復" : "已封存（歷史造型仍可正常開啟）")}>{m.status === "archived" ? "恢復" : "封存"}</Act>}
                      {!m.builtin && !m.looks && <Act danger disabled={busy} onClick={() => { if (confirm(`刪除「${m.name}」？這個身體的衣服設定及部件圖片會一併刪除。`)) void run(() => api(`/api/doll/models/${m.id}`, { method: "DELETE" }).then(load), "已刪除"); }}>刪除</Act>}
                    </div>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <input ref={file} type="file" accept=".zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void run(async () => { const mid = await importModelPackage(f); navigate(`/dressing/models/${mid}`); }, "已匯入角色套件"); }} />
    </div>
  );
}

// ───── 頭部 ─────
type RawAsset = Parameters<typeof userAsset>[0];
function useAssets(kind: "head" | "hair") {
  const [list, setList] = useState<DollAsset[] | null>(null);
  const load = () => api<{ assets: RawAsset[] }>(`/api/doll/assets?kind=${kind}`).then((r) => setList(r.assets.map(userAsset).filter((a): a is DollAsset => !!a))).catch((e) => toast((e as Error).message, "err"));
  useEffect(() => { void load(); }, [kind]);
  return { list, load };
}
const rename = (run: Run, a: DollAsset, load: () => void) => { const name = prompt("新名稱", a.name)?.trim(); if (name) void run(() => api(`/api/doll/assets/${a.id}`, { method: "PATCH", json: { name } }).then(load), "已改名"); };
const remove = (run: Run, a: DollAsset, load: () => void) => { if (confirm(`刪除「${a.name}」？已保存的造型仍在使用時不能刪除。`)) void run(() => api(`/api/doll/assets/${a.id}`, { method: "DELETE" }).then(load), "已刪除"); };
async function uploadAsset(kind: "head" | "hair", f: File, cat?: HairCat) {
  const p = await prepareAsset(f);
  const name = f.name.replace(/\.[a-z]+$/i, "").slice(0, 30) || (kind === "head" ? "新頭部" : HAIR_CAT_LABEL[cat ?? "other"]);
  const a = await api<{ id: string }>("/api/doll/assets", { method: "POST", json: { kind, name, ...(kind === "hair" ? { category: HAIR_CAT_LABEL[cat ?? "other"] } : {}) } });
  try {
    const up = await api<{ ref: string }>(`/api/doll/assets/${a.id}/files`, { method: "POST", body: p.blob, headers: { "content-type": "image/png" } });
    const ar = p.height / p.width;
    const config = kind === "head"
      ? (() => { const h = 272, w = h / ar; return { file: up.ref, x: Math.round((601 - w / 2) * 10) / 10, y: 36, w: Math.round(w * 10) / 10, h }; })()
      : { parts: [{ id: "p1", label: HAIR_CAT_LABEL[cat!], cat, layer: HAIR_CAT_LAYER[cat!], bone: HAIR_CAT_BONE[cat!] ?? "head", file: up.ref, ...placeHairPart(cat!, ar) }] };
    await api(`/api/doll/assets/${a.id}`, { method: "PATCH", json: { config } });
    await api(`/api/doll/assets/${a.id}/thumb`, { method: "PUT", body: p.thumb, headers: { "content-type": "image/png" } }).catch(() => undefined);
  } catch (e) { await api(`/api/doll/assets/${a.id}`, { method: "DELETE" }).catch(() => undefined); throw e; }
}
function Heads({ busy, run }: { busy: boolean; run: Run }) {
  const { list, load } = useAssets("head");
  const file = useRef<HTMLInputElement>(null);
  return (
    <div data-testid="studio-heads">
      <div className="flex flex-wrap gap-1.5 pb-2">
        <button type="button" disabled={busy} onClick={() => file.current?.click()} className="btn-jewel rounded-full px-3.5 py-1.5 text-[13px]">上傳頭部（透明 PNG）</button>
      </div>
      <p className="pb-2 text-[11.5px] leading-snug text-mauve">新頭部自動放在原本頭部的位置。重新對位、縮放：在換裝頁「外貌 › 頭部」按鉛筆；個別身體上的對位：在身體編輯器的「頭部」分頁。</p>
      {!list ? <div className="py-10"><Spinner /></div> : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[...BUILTIN_HEADS, ...list].map((a) => (
            <li key={a.id}><Card><div className="flex gap-2"><Thumb src={a.thumb ?? BUILTIN_THUMB[a.id]} label={a.name} /><div className="min-w-0 flex-1"><div className="truncate text-[13px]">{a.name}</div><div className="text-[10.5px] text-mauve">{a.builtin ? "內置" : "我的頭部"}</div>
              {!a.builtin && <div className="mt-1 flex flex-wrap gap-1"><Act onClick={() => rename(run, a, load)}>改名</Act><Act danger disabled={busy} onClick={() => remove(run, a, load)}>刪除</Act></div>}</div></div></Card></li>
          ))}
        </ul>
      )}
      <input ref={file} type="file" accept="image/png,image/webp" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; if (fs.length) void run(async () => { for (const f of fs) await uploadAsset("head", f); await load(); }, "已加入頭部"); }} />
    </div>
  );
}

// ───── 髮型 ─────
function Hairs({ busy, run }: { busy: boolean; run: Run }) {
  const { list, load } = useAssets("hair");
  const [cat, setCat] = useState<HairCat | "set" | "all">("all");
  const [upCat, setUpCat] = useState<HairCat>("bangs");
  const file = useRef<HTMLInputElement>(null);
  const all = useMemo(() => [...BUILTIN_HAIRS, ...(list ?? [])], [list]);
  const shown = all.filter((a) => { const parts = (a.config as HairConfig).parts; return cat === "all" || (cat === "set" ? parts.length > 1 : parts.length === 1 && hairCatOf(parts[0]) === cat); });
  return (
    <div data-testid="studio-hair">
      <div className="flex flex-wrap items-center gap-1.5 pb-2">
        <select aria-label="新髮件分類" value={upCat} onChange={(e) => setUpCat(e.target.value as HairCat)} className="h-8 rounded-full bg-velvet px-2 text-[12.5px] ring-1 ring-gold/40">{HAIR_CATS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
        <button type="button" disabled={busy} onClick={() => file.current?.click()} className="btn-jewel rounded-full px-3.5 py-1.5 text-[13px]">上傳髮件</button>
      </div>
      <div className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-2">
        {([["all", "全部"], ["set", "整套髮型"], ...HAIR_CATS.map((c) => [c.id, c.label])] as [string, string][]).map(([c, l]) => <button key={c} type="button" onClick={() => setCat(c as HairCat)} className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] ${cat === c ? "chip-on" : "bg-white/5 text-cream/85"}`}>{l}</button>)}
      </div>
      <p className="pb-2 text-[11.5px] leading-snug text-mauve">像換裝遊戲一樣：在換裝頁「外貌 › 髮型」按分類揀選瀏海、後髮、側髮、馬尾及髮尾，同一分類互相替換。網格變形、染色、挑染及髮尾漸層在換裝頁調整。</p>
      {!list ? <div className="py-10"><Spinner /></div> : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {shown.map((a) => {
            const parts = (a.config as HairConfig).parts;
            const thumb = a.thumb ?? BUILTIN_THUMB[a.id] ?? (parts[0] ? refUrl(parts[0].file) : null);
            return (
              <li key={a.id}><Card><div className="flex gap-2"><Thumb src={thumb} label={a.name} /><div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">{parts.length === 1 && /^(新髮型|我的髮型)$/.test(a.name) ? hairPartName(parts[0]) : a.name}</div>
                <div className="text-[10.5px] text-mauve">{parts.length > 1 ? `整套 ${parts.length} 件` : HAIR_CAT_LABEL[hairCatOf(parts[0])]}{a.category ? `｜${a.category}` : ""}</div>
                <div className="mt-0.5 flex flex-wrap gap-0.5">{[...new Set(parts.map((p) => HAIR_CAT_LABEL[hairCatOf(p)]))].map((c) => <span key={c} className="rounded-full bg-white/10 px-1.5 text-[9.5px] leading-[15px]">{c}</span>)}</div>
                {!a.builtin && <div className="mt-1 flex flex-wrap gap-1"><Act onClick={() => rename(run, a, load)}>改名</Act><Act onClick={() => { const c = prompt("分類名稱（例如 雙馬尾、短髮）", a.category ?? "")?.trim(); if (c !== undefined) void run(() => api(`/api/doll/assets/${a.id}`, { method: "PATCH", json: { category: c || null } }).then(load), "已更新分類"); }}>分類</Act><Act danger disabled={busy} onClick={() => remove(run, a, load)}>刪除</Act></div>}
              </div></div></Card></li>
            );
          })}
        </ul>
      )}
      <input ref={file} type="file" accept="image/png,image/webp" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; if (fs.length) void run(async () => { for (const f of fs) await uploadAsset("hair", f, upCat); await load(); }, `已加入${HAIR_CAT_LABEL[upCat]}`); }} />
    </div>
  );
}

// ───── 姿勢 ─────
function Poses({ busy, run }: { busy: boolean; run: Run }) {
  const [poses, setPoses] = useState<SavedPose[] | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const load = (fresh = true) => fetchPoses(fresh).then(setPoses).catch((e) => toast((e as Error).message, "err"));
  useEffect(() => { void load(false); listModels().then((r) => setModels(r.models)).catch(() => undefined); }, []);
  const label = (id: string | null) => (id ? models.find((m) => m.id === id)?.name ?? "已封存的身體" : "所有身體");
  return (
    <div data-testid="studio-poses">
      <p className="pb-2 text-[11.5px] leading-snug text-mauve">在換裝頁「姿勢 › 我的姿勢」保存目前姿勢。這裡可以改名、複製、指定適用的身體及刪除。內置姿勢保留在「預設姿勢」。</p>
      {!poses ? <div className="py-10"><Spinner /></div> : !poses.length ? <p className="py-10 text-center text-[12.5px] text-mauve">未有保存的姿勢</p> : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {poses.map((p) => (
            <li key={p.id}><Card><div className="flex gap-2"><Thumb src={p.thumb} label={p.name} /><div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">{p.name}</div><div className="text-[10.5px] text-mauve">{label(p.model_id)}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Act onClick={() => { const name = prompt("新名稱", p.name)?.trim(); if (name) void run(() => api(`/api/doll/poses/${p.id}`, { method: "PATCH", json: { name } }).then(() => load()), "已改名"); }}>改名</Act>
                <Act disabled={busy} onClick={() => void run(() => api("/api/doll/poses", { method: "POST", json: { name: (p.name + " 副本").slice(0, 30), model_id: p.model_id, pose: p.pose, front: p.front } }).then(() => load()), "已複製")}>複製</Act>
                <select aria-label="適用身體" value={p.model_id ?? ""} onChange={(e) => void run(() => api(`/api/doll/poses/${p.id}`, { method: "PATCH", json: { model_id: e.target.value || null } }).then(() => load()), "已更新")} className="h-6 max-w-[7rem] rounded-full bg-white/10 px-1.5 text-[11px]"><option value="">所有身體</option>{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
                <Act danger disabled={busy} onClick={() => { if (confirm(`刪除姿勢「${p.name}」？`)) void run(() => api(`/api/doll/poses/${p.id}`, { method: "DELETE" }).then(() => load()), "已刪除"); }}>刪除</Act>
              </div>
            </div></div></Card></li>
          ))}
        </ul>
      )}
    </div>
  );
}
