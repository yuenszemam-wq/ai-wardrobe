// 我的姿勢庫（Phase 3.6C）：保存目前姿勢、套用、改名、複製、以目前姿勢更新及刪除。
// 姿勢可以只屬於某個身體，或適用於所有相容身體；套用時一律按目前身體的活動範圍限制。
import { useEffect, useState } from "react";
import { Pose, Rig, clampPose, samePose } from "../../shared/avatarRig";
import { AvatarModel, isBuiltinModel } from "../../shared/avatarModel";
import { AVATAR_V2_ID, FrontPart } from "../../shared/avatarV2";
import { api } from "../api";
import { toast } from "../components/ui";
import { DollRenderer, Scene } from "./engine";

export interface SavedPose { id: string; name: string; model_id: string | null; pose: Pose; front: FrontPart[]; thumb: string | null; updated_at: string }
let cache: Promise<SavedPose[]> | null = null;
export const fetchPoses = (fresh = false) => { if (fresh || !cache) { cache = api<{ poses: SavedPose[] }>("/api/doll/poses").then((r) => r.poses); cache.catch(() => { cache = null; }); } return cache; };

async function thumbFor(renderer: DollRenderer, scene: Scene, id: string) {
  try {
    const blob = await renderer.thumbnail({ ...scene, overlay: null, flat: null, wire: null }, 150);
    if (blob) await api(`/api/doll/poses/${id}/thumb`, { method: "PUT", body: blob, headers: { "content-type": "image/jpeg" } });
  } catch { /* 縮圖失敗不影響姿勢 */ }
}

export function PoseLibrary({ model, rig, pose, front, onApply, renderer, scene }: { model: AvatarModel; rig: Rig; pose: Pose; front: FrontPart[]; onApply: (p: Pose, f: FrontPart[]) => void; renderer: DollRenderer; scene: Scene }) {
  const [poses, setPoses] = useState<SavedPose[] | null>(null);
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const reload = (fresh = false) => fetchPoses(fresh).then(setPoses).catch((e) => toast((e as Error).message, "err"));
  useEffect(() => { void reload(); }, []);
  const modelId = model.id || AVATAR_V2_ID;
  const shown = (poses ?? []).filter((p) => scope === "all" ? !p.model_id || p.model_id === modelId : p.model_id === modelId);
  const run = async (fn: () => Promise<unknown>, done?: string) => { setBusy(true); try { await fn(); await reload(true); if (done) toast(done); } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); setMenu(null); } };
  const save = (onlyThis: boolean) => {
    const name = prompt("姿勢名稱", "我的姿勢")?.trim();
    if (!name) return;
    void run(async () => { const p = await api<SavedPose>("/api/doll/poses", { method: "POST", json: { name, model_id: onlyThis ? modelId : null, pose: clampPose(rig, pose), front } }); await thumbFor(renderer, scene, p.id); }, "已保存到我的姿勢");
  };
  return (
    <div data-testid="pose-library">
      <div className="flex flex-wrap items-center gap-1.5 pb-2">
        <button type="button" data-testid="pose-save" disabled={busy} onClick={() => save(false)} className="btn-jewel rounded-full px-3 py-1.5 text-[12px] disabled:opacity-50">保存目前姿勢</button>
        {!isBuiltinModel(model.id) && <button type="button" disabled={busy} onClick={() => save(true)} className="chip rounded-full px-3 py-1.5 text-[12px]">只保存給這個身體</button>}
        <button type="button" aria-pressed={scope === "mine"} onClick={() => setScope(scope === "all" ? "mine" : "all")} className={`ml-auto rounded-full px-3 py-1.5 text-[12px] ${scope === "mine" ? "chip-on" : "chip"}`}>{scope === "mine" ? "只顯示這個身體" : "顯示全部相容姿勢"}</button>
      </div>
      {!poses ? <p className="py-3 text-center text-[11.5px] text-mauve">載入中…</p> : !shown.length ? <p className="py-3 text-center text-[11.5px] text-mauve">未有保存的姿勢。擺好姿勢後按「保存目前姿勢」。</p> : (
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
          {shown.map((p) => {
            const on = samePose(rig, clampPose(rig, p.pose), pose);
            return (
              <div key={p.id} className="relative">
                <button type="button" data-my-pose={p.id} aria-pressed={on} onClick={() => onApply(p.pose, p.front)} className={`block w-full rounded-xl p-1 text-center ${on ? "chip-on" : "bg-cream/5"}`}>
                  <div className="aspect-[2/3] overflow-hidden rounded-lg bg-cream/70">{p.thumb ? <img src={p.thumb} alt="" loading="lazy" className="h-full w-full object-contain" /> : null}</div>
                  <div className="truncate pt-0.5 text-[10.5px]">{p.name}{p.model_id ? " ●" : ""}</div>
                </button>
                <button type="button" aria-label={`${p.name} 的選項`} onClick={() => setMenu(menu === p.id ? null : p.id)} className="btn-dark absolute right-0.5 top-0.5 grid h-6 w-6 place-items-center rounded-full text-[11px]">⋯</button>
                {menu === p.id && (
                  <div className="absolute right-0 top-7 z-10 w-36 overflow-hidden rounded-xl border border-gold/50 bg-velvet text-[12px] shadow-xl" role="menu">
                    <button type="button" className="block w-full px-3 py-2 text-left" onClick={() => { const name = prompt("新名稱", p.name)?.trim(); if (name) void run(() => api(`/api/doll/poses/${p.id}`, { method: "PATCH", json: { name } }), "已改名"); }}>改名</button>
                    <button type="button" className="block w-full px-3 py-2 text-left" onClick={() => void run(async () => { await api(`/api/doll/poses/${p.id}`, { method: "PATCH", json: { pose: clampPose(rig, pose), front } }); await thumbFor(renderer, scene, p.id); }, "已用目前姿勢更新")}>用目前姿勢更新</button>
                    <button type="button" className="block w-full px-3 py-2 text-left" onClick={() => void run(async () => { const c = await api<SavedPose>("/api/doll/poses", { method: "POST", json: { name: (p.name + " 副本").slice(0, 30), model_id: p.model_id, pose: p.pose, front: p.front } }); if (p.thumb) { const b = await fetch(p.thumb, { credentials: "same-origin" }).then((r) => r.blob()).catch(() => null); if (b) await api(`/api/doll/poses/${c.id}/thumb`, { method: "PUT", body: b, headers: { "content-type": b.type || "image/jpeg" } }).catch(() => undefined); } }, "已複製")}>複製</button>
                    <button type="button" className="block w-full px-3 py-2 text-left" onClick={() => void run(() => api(`/api/doll/poses/${p.id}`, { method: "PATCH", json: { model_id: p.model_id ? null : modelId } }), p.model_id ? "已設為所有身體適用" : "已設為只屬於這個身體")}>{p.model_id ? "設為所有身體適用" : "只屬於這個身體"}</button>
                    <button type="button" className="block w-full px-3 py-2 text-left text-wine" onClick={() => { if (confirm(`刪除姿勢「${p.name}」？`)) void run(() => api(`/api/doll/poses/${p.id}`, { method: "DELETE" }), "已刪除"); }}>刪除</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="pt-2 text-[10.5px] leading-snug text-mauve">● ＝只屬於某個身體。不同身體比例及活動範圍未必相同；套用時超出範圍的關節會自動調整。</p>
    </div>
  );
}
