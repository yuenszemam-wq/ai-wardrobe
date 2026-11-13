// 換裝頁底部面板：衣服、圖層（已穿衣物）、外貌、姿勢。面板保持矮小，角色始終可見。
import { ReactNode, useMemo, useState } from "react";
import { Pose, Rig, boneMap, clampPose, samePose } from "../../shared/avatarRig";
import { BONE_GROUPS, BONE_LABEL, BUILTIN_HAIRS, BUILTIN_HEADS, DollAsset, FrontPart, HairConfig, HairPart, HAIR_LAYER_LABEL, HAIR_COLORS, NO_HAIR_ID, POSE_PRESETS, resolveHairColors, rgbToHex } from "../../shared/avatarV2";
import { ATTACHABLE_BONES, FOLLOWS, Follow, SLEEVE_ROT_LIMIT, SLOT_LABEL, SLOT_SKIN, WearOpts } from "../../shared/doll";
import { Garment, displayName, imageUrl } from "../api";
import { IconClose, IconEye, IconEyeOff, IconGrip, IconPencil, IconPlus, IconSearch, IconTrash } from "../components/icons";
import { SortableList } from "../components/Sortable";
import { TransparentImage } from "../components/TransparentImage";
import { RigInfo } from "../../shared/garmentMesh";
import { Appearance, BUILTIN_THUMB, Resolved, addHairParts, hairOf } from "./model";
import { PoseHandle } from "./Stage";

export const pill = (on: boolean) => `shrink-0 rounded-full px-3 py-1.5 text-[12.5px] ${on ? "chip-on" : "chip"}`;
const H = ({ children }: { children: ReactNode }) => <h3 className="mb-1.5 mt-3 text-[11.5px] tracking-[0.12em] text-gold-soft first:mt-0">{children}</h3>;
const Row = ({ children, className = "" }: { children: ReactNode; className?: string }) => <div className={`scrollbar-none -mx-3 flex gap-1.5 overflow-x-auto px-3 ${className}`}>{children}</div>;

// ───── 衣服 ─────
export function ClothesPanel({ garments, wornIds, pending, onToggle }: { garments: Garment[] | null; wornIds: Set<string>; pending: Set<string>; onToggle: (g: Garment) => void }) {
  const [cat, setCat] = useState("");
  const [source,setSource]=useState("");
  const sourceHair=hairs.find(h=>h.id===source);
  const current=hair?.parts??[];
  const selected=current.find(p=>p.id===selectedHair);
  const changeParts=(parts:HairPart[])=>onChange({...value,hair_config:{...hair,parts}});
  const add=(parts:HairPart[])=>{const next=addHairParts(hair,parts);onChange({...value,hair_config:next});if(next.parts.length>current.length)onSelectHair(next.parts[next.parts.length-1].id);};
  const [q, setQ] = useState("");
  const [search, setSearch] = useState(false);
  const cats = useMemo(() => [...new Set((garments || []).map((g) => g.category || "").filter(Boolean))], [garments]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (garments || []).filter((g) => (!cat || g.category === cat) && (!needle || [g.name, g.brand, g.subcategory, g.style, g.primary_color].some((v) => (v || "").toLowerCase().includes(needle))));
  }, [garments, cat, q]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 pb-2">
        <button type="button" aria-label="搜尋衣物" aria-pressed={search} onClick={() => { setSearch(!search); setQ(""); }} className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[15px] ${search ? "chip-on" : "chip"}`}><IconSearch /></button>
        {search ? (
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="名稱、品牌、顏色…" aria-label="搜尋" className="h-8 min-w-0 flex-1 rounded-full bg-white px-3 text-[13px] text-ink ring-1 ring-gold focus:outline-none" />
        ) : (
          <div className="scrollbar-none -mr-3 flex min-w-0 flex-1 gap-1.5 overflow-x-auto pr-3" data-testid="doll-cats">
            {["", ...cats].map((c) => <button key={c || "all"} type="button" onClick={() => setCat(c)} className={pill(cat === c)}>{c || "全部"}</button>)}
          </div>
        )}
      </div>
      <div className="scrollbar-none -mx-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2">
        {!garments ? <p className="py-6 text-center text-[12px] text-mauve">載入衣櫃中…</p> : list.length === 0 ? (
          <p className="py-6 text-center text-[12px] leading-relaxed text-mauve">{garments.length ? "沒有符合的衣物" : "衣櫃未有已入庫而且有透明圖的衣物"}</p>
        ) : (
          <div className="grid grid-cols-4 gap-x-2 gap-y-2.5 sm:grid-cols-6" data-testid="doll-picker">
            {list.map((g) => {
              const on = wornIds.has(g.id);
              return (
                <button key={g.id} type="button" data-garment={g.id} aria-pressed={on} onClick={() => onToggle(g)} className="relative block text-left">
                  <div className={`arch arch-base relative aspect-[3/4] ${on ? "outline-2 outline-offset-1 outline-gold-soft" : ""} ${pending.has(g.id) ? "opacity-60" : ""}`}>
                    <div className="absolute inset-0 overflow-hidden" style={{ borderRadius: "inherit" }}>
                      <TransparentImage src={imageUrl(g.transparent_image_id)} alt={displayName(g)} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-contain px-[8%] pb-[8%] pt-[18%]" />
                    </div>
                  </div>
                  {on && <span className="btn-jewel absolute -left-0.5 -top-0.5 grid h-5 w-5 place-items-center rounded-full text-[10px]">✓</span>}
                  <div className="truncate pt-1 text-center text-[10.5px] text-cream/90">{displayName(g)}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ───── 圖層（已穿衣物） ─────
export function LayersPanel({ items, selected, onSelect, onReorder, onHide, onRemove, onClear, hints }: {
  items: Resolved[]; selected: string | null; onSelect: (id: string | null) => void; onReorder: (ids: string[]) => void; onHide: (id: string) => void; onRemove: (id: string) => void; onClear: () => void; hints: string[];
}) {
  // 清單由上到下＝由外到內（與 Photoshop 圖層相同）
  const rows = useMemo(() => [...items].reverse().map((r) => ({ id: r.garment.id, r })), [items]);
  if (!items.length) return <p className="py-8 text-center text-[12px] leading-relaxed text-mauve">角色仍未穿上衣物。<br />到「衣服」點選衣物，可以自由疊穿多件。</p>;
  return (
    <div className="scrollbar-none -mx-3 h-full overflow-y-auto overscroll-contain px-3 pb-2">
      <div className="mb-1.5 flex items-center justify-between text-[11.5px] text-mauve">
        <span>已穿 {items.length} 件｜上面的在外層，按住 ☰ 拖動排序</span>
        <button type="button" data-testid="clear-all" onClick={onClear} className="chip rounded-full px-2.5 py-1 text-[11.5px]">全部脫下</button>
      </div>
      {hints.map((h) => <p key={h} role="note" className="mb-1.5 rounded-xl bg-white/5 px-2.5 py-1.5 text-[11px] leading-snug text-gold-soft">提示：{h}</p>)}
      <SortableList<{ id: string; r: Resolved }>
        items={rows}
        onReorder={(ids) => onReorder([...ids].reverse())}
        className="space-y-1.5"
        render={({ r }, handle, dragging) => {
          const on = r.garment.id === selected;
          return (
            <div data-layer={r.garment.id} className={`flex items-center gap-2 rounded-2xl py-1 pl-1.5 pr-1.5 ${on ? "chip-on" : "chip"} ${dragging ? "opacity-70" : ""} ${r.worn.hidden ? "opacity-60" : ""}`}>
              <button type="button" {...handle} className="grid h-9 w-7 shrink-0 place-items-center text-[16px] opacity-80"><IconGrip /></button>
              <button type="button" onClick={() => onSelect(on ? null : r.garment.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <span className="relative h-10 w-8 shrink-0 overflow-hidden rounded-lg bg-white/85"><TransparentImage src={imageUrl(r.garment.transparent_image_id)} alt="" className="absolute inset-0 h-full w-full object-contain" /></span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px]">{displayName(r.garment as Garment)}</span>
                  <span className="block text-[10.5px] opacity-75">{SLOT_LABEL[r.worn.slot]}{r.worn.variant && r.template?.data?.variants[r.worn.variant] ? `｜${r.template.data.variants[r.worn.variant].name}` : ""}{r.from === "override" ? "｜已個別調整" : ""}</span>
                </span>
              </button>
              <button type="button" aria-label={r.worn.hidden ? "顯示" : "暫時隱藏"} aria-pressed={r.worn.hidden} onClick={() => onHide(r.garment.id)} className="grid h-9 w-8 shrink-0 place-items-center text-[17px]">{r.worn.hidden ? <IconEyeOff /> : <IconEye />}</button>
              <button type="button" aria-label="脫下" onClick={() => onRemove(r.garment.id)} className="grid h-9 w-8 shrink-0 place-items-center text-[15px]"><IconClose /></button>
            </div>
          );
        }}
      />
    </div>
  );
}

// ───── 已選衣物的校正 ─────
export type FitTool = "place" | "wear" | "parts" | "follow" | "mask" | "mesh";
export interface MaskTool { mode: "hide" | "behind" | "restore"; size: number }
/** 部件筆刷：0＝衣身、1＝右袖、2＝左袖 */
export interface PartTool { label: number; size: number }
const FOLLOW_LABEL: Record<Follow, string> = { auto: "自動", none: "整件不變形", upper: "袖子只跟上臂", full: "袖子跟手肘彎曲" };
const FOLLOW_LABEL_LEG: Record<Follow, string> = { auto: "自動", none: "整件不變形", upper: "跟隨腿部", full: "跟隨腿部" };
/** 這件衣物目前怎樣跟隨骨架（一句說明） */
export function rigSummary(info: RigInfo | null, skin: string): string {
  if (!info) return "";
  if (info.mode === "rigid") return "整件一起移動，不會變形。";
  if (skin === "legs") return info.legs ? "褲管／襪／鞋各自跟隨兩條腿，每一邊都是完整的一塊。" : "整件跟隨骨盆。";
  const sides = [info.sleeve_r && "右袖", info.sleeve_l && "左袖"].filter(Boolean).join("、");
  if (!sides) return info.source === "whole" ? "整件衣物（不拆袖）：衣身跟隨上身彎曲，保持完整。" : info.unsure ? "未能可靠分辨袖子，現時以整件衣物顯示（保持完整）。可以用筆刷標記袖子。" : "沒有找到袖子：整件衣物跟隨上身，保持完整。";
  return `${info.source === "manual" ? "人工標記" : info.source === "zone" ? "按手臂位置估計" : "自動分辨"}：${sides}跟隨手臂${info.forearm ? "（連手肘）" : ""}，衣身保持完整。`;
}
export function FitPanel({ r, info, tool, setTool, busy, onFit, onMeshReset, onOpts, onAuto, onRestore, onSaveDefault, onRemove, onDone, onOrder, onVariant, onAddVariant, onDeleteVariant, onSavePose, onApplyPose, mask, setMask, onClearMask, part, setPart, hint, setHint, onParts, onSleeveAuto, onPoseFix }: {
  r: Resolved; info: RigInfo | null; tool: FitTool; setTool: (t: FitTool) => void; busy: boolean;
  part: PartTool; setPart: (p: PartTool) => void; hint: boolean; setHint: (v: boolean) => void; onParts: (v: string | null) => void; onSleeveAuto: () => void; onPoseFix: () => void;
  onMeshReset: () => void;
  onFit: (f: { dx?: number; dy?: number; scale?: number; rot?: number; wide?: number; tall?: number }) => void; onOpts: (o: Partial<WearOpts>) => void; onAuto: () => void; onRestore: () => void; onSaveDefault: () => void; onRemove: () => void; onDone: () => void;
  onOrder: (to: "top" | "up" | "down" | "bottom") => void; onVariant: (id: string | null) => void; onAddVariant: (withImage: boolean) => void; onDeleteVariant: (id: string) => void; onSavePose: () => void; onApplyPose: () => void;
  mask: MaskTool; setMask: (m: MaskTool) => void; onClearMask: () => void;
}) {
  const variants = Object.entries(r.template?.data?.variants ?? {});
  const skin = SLOT_SKIN[r.worn.slot];
  const upperRig = skin === "upper" && !r.opts.bone && r.opts.follow !== "none";
  const B = ({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) => <button type="button" aria-label={label} onClick={onClick} className="chip grid h-9 min-w-9 place-items-center rounded-full px-2.5 text-[14px]">{children}</button>;
  const FROM = { default: "自動估算的位置", template: "衣物預設位置", converted: "由舊角色換算，建議校正後存為預設", override: "已調整（只用於這個造型）" }[r.from];
  return (
    <div className="flex h-full flex-col" data-testid="fit-panel">
      <div className="flex items-center gap-2 pb-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium">{displayName(r.garment as Garment)}</div>
          <div className="truncate text-[10.5px] text-mauve" data-testid="fit-from">{FROM}</div>
        </div>
        <button type="button" onClick={onRemove} className="chip flex h-8 items-center gap-1 rounded-full px-2.5 text-[12px]"><IconTrash className="text-[13px]" />脫下</button>
        <button type="button" data-testid="fit-done" onClick={onDone} className="btn-jewel h-8 rounded-full px-3.5 text-[12.5px]">完成</button>
      </div>
      <Row className="pb-2">
        {([["place", "位置"], ["mesh", "變形"], ["mask", "遮罩"], ["wear", "穿法"], ["parts", "部件"], ["follow", "進階骨架"]] as [FitTool, string][]).map(([t, label]) => <button key={t} type="button" data-tool={t} onClick={() => setTool(t)} className={pill(tool === t)}>{label}</button>)}
      </Row>
      <div className="scrollbar-none -mx-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 text-[12.5px]">
        {tool === "place" && (
          <>
            <p className="mb-2 text-[11px] leading-snug text-mauve">在角色上直接拖動衣物；角位把手調整衣物大小，雙指放大或平移人物畫布。</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <B label="向左微調" onClick={() => onFit({ dx: -4 })}>←</B><B label="向右微調" onClick={() => onFit({ dx: 4 })}>→</B><B label="向上微調" onClick={() => onFit({ dy: -4 })}>↑</B><B label="向下微調" onClick={() => onFit({ dy: 4 })}>↓</B>
              <B label="放大" onClick={() => onFit({ scale: 1.03 })}>＋</B><B label="縮小" onClick={() => onFit({ scale: 1 / 1.03 })}>－</B>
              <B label="向左轉" onClick={() => onFit({ rot: -1 })}>↺</B><B label="向右轉" onClick={() => onFit({ rot: 1 })}>↻</B>
              <button type="button" onClick={onAuto} className="chip h-9 rounded-full px-3">自動對位</button>
            </div>
            <H>闊度及高度（獨立微調）</H>
            <div className="flex flex-wrap items-center gap-1.5" data-testid="fit-stretch">
              <button type="button" data-stretch="wide" onClick={() => onFit({ wide: 1.03 })} className="chip h-9 rounded-full px-3">加闊</button>
              <button type="button" data-stretch="narrow" onClick={() => onFit({ wide: 1 / 1.03 })} className="chip h-9 rounded-full px-3">收窄</button>
              <button type="button" data-stretch="tall" onClick={() => onFit({ tall: 1.03 })} className="chip h-9 rounded-full px-3">拉長</button>
              <button type="button" data-stretch="short" onClick={() => onFit({ tall: 1 / 1.03 })} className="chip h-9 rounded-full px-3">縮短</button>
              {r.fit.sy && <button type="button" onClick={() => onFit({ tall: 1 / r.fit.sy! })} className="chip h-9 rounded-full px-3">回復原比例</button>}
            </div>
            <H>圖層</H>
            <div className="flex flex-wrap gap-1.5">
              {([["top", "移到最前"], ["up", "前移一層"], ["down", "後移一層"], ["bottom", "移到最後"]] as const).map(([k, label]) => <button key={k} type="button" data-order={k} onClick={() => onOrder(k)} className="chip h-9 rounded-full px-3">{label}</button>)}
            </div>
          </>
        )}
        {tool === "mesh" && <><p className="mb-2 text-[11px] text-mauve">直接拖動紫色網格控制點，整件衣服保持連續。雙指放大人物；切換位置可隱藏網格。若要調整手臂配合袖口，可先把衣物固定於畫布。</p><div className="flex flex-wrap gap-2"><button type="button" data-testid="mesh-reset" onClick={onMeshReset} className="chip h-9 rounded-full px-3">重設變形</button><button type="button" data-testid="mesh-fixed" onClick={()=>onOpts({follow:"none",bone:"world"})} className={pill(r.opts.bone==="world")}>衣物固定</button><button type="button" onClick={()=>onOpts({follow:"none",bone:null})} className={pill(r.opts.follow==="none"&&!r.opts.bone)}>跟隨身體</button></div></>}
        {tool === "wear" && (
          <>
            <p className="mb-2 text-[11px] leading-snug text-mauve">同一件衣服可以保存不同穿著方式，例如外套打開／關上、襯衫收入裙內／放出。需要另一張圖的穿法（例如打開的外套）可上傳透明圖。</p>
            <div className="flex flex-wrap gap-1.5" data-testid="variants">
              <button type="button" onClick={() => onVariant(null)} className={pill(!r.worn.variant)}>預設穿法</button>
              {variants.map(([id, v]) => (
                <span key={id} className={`flex items-center rounded-full ${r.worn.variant === id ? "chip-on" : "chip"}`}>
                  <button type="button" data-variant={id} onClick={() => onVariant(id)} className="py-1.5 pl-3 pr-1 text-[12.5px]">{v.name}</button>
                  <button type="button" aria-label={`刪除穿法 ${v.name}`} onClick={() => onDeleteVariant(id)} className="grid h-7 w-7 place-items-center text-[11px] opacity-70"><IconClose /></button>
                </span>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button type="button" disabled={busy} data-testid="add-variant" onClick={() => onAddVariant(false)} className="chip flex h-9 items-center gap-1 rounded-full px-3"><IconPlus className="text-[12px]" />把目前調整存為新穿法</button>
              <button type="button" disabled={busy} onClick={() => onAddVariant(true)} className="chip flex h-9 items-center gap-1 rounded-full px-3"><IconPlus className="text-[12px]" />上傳另一張圖的穿法</button>
            </div>
            <H>姿勢校正</H>
            <p className="mb-2 text-[11px] leading-snug text-mauve">同一件衣服在不同姿勢下可以有各自的校正（位置、部件、遮罩）。先擺好姿勢並調整好衣服，再保存；之後擺出相近姿勢時，畫面會提示可以套用，不會自動更改。</p>
            <button type="button" disabled={busy} data-testid="add-pose-fix" onClick={onPoseFix} className="chip flex h-9 items-center gap-1 rounded-full px-3"><IconPlus className="text-[12px]" />把目前調整存為這個姿勢的校正</button>
            <H>建議姿勢</H>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" disabled={!r.template?.data?.pose} onClick={onApplyPose} className="chip h-9 rounded-full px-3 disabled:opacity-40">套用這件衣服的建議姿勢</button>
              <button type="button" disabled={busy} onClick={onSavePose} className="chip h-9 rounded-full px-3">把目前姿勢設為建議姿勢</button>
            </div>
          </>
        )}
        {tool === "parts" && (
          <>
            <p className="mb-2 text-[11px] leading-snug text-mauve" data-testid="rig-summary">{rigSummary(info, skin)}</p>
            {!upperRig ? (
              <p className="text-[11px] leading-snug text-mauve">{skin === "upper" ? "這件衣物現時設定為整件不變形。到「骨架」把跟隨方式改為「自動」，就可以標記袖子。" : "這類衣物不需要標記部件。"}</p>
            ) : (
              <>
                <p className="mb-2 text-[11px] leading-snug text-mauve">自動分辨不準確時，直接在角色身上塗出袖子的範圍；任何姿勢下塗抹的都是你看到的那塊布料。每個部件都是完整的一塊，袖根與衣身保持連接。</p>
                <div className="flex flex-wrap items-center gap-1.5" data-testid="part-tools">
                  {([[1, "右袖（畫面左邊）"], [2, "左袖（畫面右邊）"], [0, "衣身"]] as const).map(([l, label]) => <button key={l} type="button" data-part={l} onClick={() => setPart({ ...part, label: l })} className={pill(part.label === l)}>{label}</button>)}
                </div>
                <label className="mt-2 flex items-center gap-2">筆刷<input type="range" min={10} max={110} value={part.size} onChange={(e) => setPart({ ...part, size: Number(e.target.value) })} className="flex-1" /></label>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <button type="button" data-testid="parts-auto" onClick={() => onParts("auto")} className={pill(!r.parts || r.parts === "auto")}>自動分辨</button>
                  <button type="button" data-testid="parts-whole" onClick={() => onParts("whole")} className={pill(r.parts === "whole")}>整件衣物（不拆袖）</button>
                  <button type="button" aria-pressed={hint} onClick={() => setHint(!hint)} className={pill(hint)}>顯示部件顏色</button>
                </div>
                <H>袖子角度（令平放拍攝的袖子貼近手臂）</H>
                {([["sleeve_r", "右袖"], ["sleeve_l", "左袖"]] as const).map(([k, label]) => (
                  <label key={k} className="mt-1 grid grid-cols-[2.6rem_1fr_2.8rem] items-center gap-2">
                    <span>{label}</span>
                    <input type="range" data-sleeve={k} min={-SLEEVE_ROT_LIMIT} max={SLEEVE_ROT_LIMIT} step={1} value={r.opts[k] ?? 0} onChange={(e) => onOpts({ [k]: Number(e.target.value) })} className="w-full" />
                    <span className="text-right tabular-nums">{r.opts[k] ?? 0}°</span>
                  </label>
                ))}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button type="button" data-testid="sleeve-auto" onClick={onSleeveAuto} className="chip h-9 rounded-full px-3">自動貼合手臂</button>
                  <button type="button" onClick={() => onOpts({ sleeve_r: 0, sleeve_l: 0 })} className="chip h-9 rounded-full px-3">回復原本角度</button>
                </div>
              </>
            )}
          </>
        )}
        {tool === "follow" && (
          <>
            {skin === "rigid" ? (
              <p className="mb-2 text-[11px] leading-snug text-mauve">這類衣物整件附接在一節骨骼上，角色活動時會跟著那個部位移動，不會被切開。</p>
            ) : (
              <>
                <p className="mb-2 text-[11px] leading-snug text-mauve" data-testid="rig-summary">衣服是一張連續的網格，只會彎曲、不會斷開。{rigSummary(info, skin)}</p>
                <div className="flex flex-wrap gap-1.5" data-testid="follow">
                  {FOLLOWS.filter((f) => skin === "upper" || f !== "upper").map((f) => <button key={f} type="button" data-follow={f} onClick={() => onOpts({ follow: f, bone: null })} className={pill(r.opts.follow === f && !r.opts.bone)}>{(skin === "upper" ? FOLLOW_LABEL : FOLLOW_LABEL_LEG)[f]}</button>)}
                </div>
              </>
            )}
            <H>整件附接的部位</H>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => onOpts({ bone: null })} className={pill(!r.opts.bone)}>按分類</button>
              {ATTACHABLE_BONES.map((b) => <button key={b} type="button" data-bone={b} onClick={() => onOpts({ bone: b })} className={pill(r.opts.bone === b)}>{b === "world" ? "固定在畫布" : BONE_LABEL[b] ?? b}</button>)}
            </div>
            <H>前後關係</H>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" data-testid="opt-neck" aria-pressed={r.opts.neck} onClick={() => onOpts({ neck: !r.opts.neck })} className={pill(r.opts.neck)}>後領放在頸後</button>
              <button type="button" aria-pressed={r.opts.over_head} onClick={() => onOpts({ over_head: !r.opts.over_head })} className={pill(r.opts.over_head)}>蓋在頭髮上面</button>
            </div>
          </>
        )}
        {tool === "mask" && (
          <>
            <p className="mb-2 text-[11px] leading-snug text-mauve">在角色身上塗抹這件衣服：「隱藏」令該部分不顯示（例如後領內側、露出的底層）；「移到身後」令該部分畫在身體後面（例如外套內裡、兜帽）。任何姿勢下，塗抹的都是你看到的那塊布料；原圖不會被修改，每一筆都可以用左下角的撤銷還原。</p>
            <div className="flex flex-wrap items-center gap-1.5" data-testid="mask-tools">
              {([["hide", "隱藏"], ["behind", "移到身後"], ["restore", "還原"]] as const).map(([m, label]) => <button key={m} type="button" data-mask={m} onClick={() => setMask({ ...mask, mode: m })} className={pill(mask.mode === m)}>{label}</button>)}
              <button type="button" data-testid="mask-clear" onClick={onClearMask} className="chip h-8 rounded-full px-3">還原整件（清除遮罩）</button>
              <button type="button" aria-pressed={hint} data-testid="mask-hint" onClick={() => setHint(!hint)} className={pill(hint)}>顯示已編輯位置</button>
            </div>
            <label className="mt-2 flex items-center gap-2">筆刷<input type="range" min={2} max={120} value={mask.size} onChange={(e) => setMask({ ...mask, size: Number(e.target.value) })} className="flex-1" /></label>
          </>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 pt-1">
        <button type="button" disabled={r.from !== "override"} data-testid="fit-restore" onClick={onRestore} className="chip h-10 rounded-full text-[12.5px] disabled:opacity-40">恢復衣物預設</button>
        <button type="button" disabled={busy || !!r.analysis.content.approximate} data-testid="fit-save-default" onClick={onSaveDefault} className="btn-jewel h-10 rounded-full text-[12.5px] disabled:opacity-40">{r.worn.variant ? "存為這個穿法的預設" : "存為衣物預設"}</button>
      </div>
    </div>
  );
}

// ───── 外貌 ─────
function AssetCard({ a, on, onPick, onEdit }: { a: { id: string; name: string; thumb?: string | null }; on: boolean; onPick: () => void; onEdit?: () => void }) {
  const src = a.thumb ?? BUILTIN_THUMB[a.id];
  return (
    <div className="relative w-[74px] shrink-0">
      <button type="button" data-asset={a.id} aria-pressed={on} onClick={onPick} className="block w-full">
        <div className={`arch arch-base relative aspect-[3/4] ${on ? "outline-2 outline-offset-1 outline-gold-soft" : ""}`}>
          {src ? <img src={src} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain px-[10%] pb-[8%] pt-[18%]" /> : <span className="absolute inset-0 grid place-items-center pt-3 text-[11px] text-mauve">{a.name.slice(0, 2)}</span>}
        </div>
        <div className="truncate pt-1 text-center text-[10.5px]">{a.name}</div>
      </button>
      {on && <span className="btn-jewel absolute -left-0.5 -top-0.5 grid h-5 w-5 place-items-center rounded-full text-[10px]">✓</span>}
      {onEdit && <button type="button" aria-label={`編輯 ${a.name}`} onClick={onEdit} className="btn-dark absolute -right-0.5 -top-0.5 grid h-6 w-6 place-items-center rounded-full text-[11px]"><IconPencil /></button>}
    </div>
  );
}
const AddCard = ({ label, onClick, testid }: { label: string; onClick: () => void; testid: string }) => (
  <button type="button" data-testid={testid} onClick={onClick} className="w-[74px] shrink-0">
    <div className="relative grid aspect-[3/4] place-items-center rounded-[999px_999px_14px_14px] border border-dashed border-gold/70 text-[20px] text-gold-soft"><IconPlus /></div>
    <div className="truncate pt-1 text-center text-[10.5px] text-gold-soft">{label}</div>
  </button>
);
export type LookTab = "hair" | "color" | "head";
export function AppearancePanel({ tab, setTab, value, onChange, assets, onNew, onEdit, hair, selectedHair, onSelectHair, hairTool, setHairTool, onHairPatch, onSaveHair, busy }: { tab: LookTab; setTab: (t: LookTab) => void; value: Appearance; onChange: (v: Appearance) => void; assets: DollAsset[]; onNew: (kind: "hair" | "head") => void; onEdit: (a: DollAsset) => void; hair: HairConfig|null; selectedHair:string|null; onSelectHair:(id:string|null)=>void; hairTool:"place"|"mesh"; setHairTool:(t:"place"|"mesh")=>void; onHairPatch:(id:string,patch:Partial<HairPart>)=>void; onSaveHair:()=>void; busy:boolean }) {
  const hairs = [...BUILTIN_HAIRS, ...assets.filter((a) => a.kind === "hair")];
  const heads = [...BUILTIN_HEADS, ...assets.filter((a) => a.kind === "head")];
  const resolved = resolveHairColors(value.hair_color, value.accent_color);
  const preset = HAIR_COLORS.find((c) => c.id === value.hair_color && !value.accent_color);
  const cats = [...new Set(hairs.map((h) => h.category).filter(Boolean))] as string[];
  const [cat, setCat] = useState("");
  const [source,setSource]=useState("");
  const current=hair?.parts??[];
  const sourceHair=hairs.find(h=>h.id===source);
  const changeParts=(parts:HairPart[])=>onChange({...value,hair_config:{...hair,parts}});
  const add=(parts:HairPart[])=>changeParts(addHairParts(current,parts));
  const selected=current.find(p=>p.id===selectedHair);

  const Swatch = ({ label, value: v, fallback, onPick, onClear, testid }: { label: string; value: string | null; fallback: string; onPick: (hex: string) => void; onClear?: () => void; testid: string }) => (
    <label className="chip relative flex min-w-0 flex-1 items-center gap-2 rounded-2xl px-2.5 py-2">
      <span className="h-7 w-7 shrink-0 rounded-lg border border-white/40" style={{ background: v ?? fallback }} />
      <span className="min-w-0"><span className="block text-[10.5px] text-mauve">{label}</span><span className="block truncate text-[12px]">{v ? v.toUpperCase() : "原色"}</span></span>
      <input type="color" data-testid={testid} aria-label={label} value={v ?? fallback} onChange={(e) => onPick(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
      {onClear && v && <button type="button" aria-label={`清除${label}`} onClick={(e) => { e.preventDefault(); onClear(); }} className="relative z-10 ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-full bg-black/25 text-[10px]"><IconClose /></button>}
    </label>
  );
  return (
    <div className="flex h-full flex-col" data-testid="appearance-panel">
      <Row className="pb-2">
        {([["hair", "髮型"], ["color", "髮色"], ["head", "頭部"]] as [LookTab, string][]).map(([t, label]) => <button key={t} type="button" data-looktab={t} onClick={() => setTab(t)} className={pill(tab === t)}>{label}</button>)}
        {tab === "hair" && cats.length > 1 && <span className="mx-1 w-px shrink-0 self-stretch bg-gold/30" />}
        {tab === "hair" && cats.length > 1 && ["", ...cats].map((c) => <button key={c || "all"} type="button" onClick={() => setCat(c)} className={pill(cat === c)}>{c || "全部"}</button>)}
      </Row>
      <div className="scrollbar-none -mx-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2">
        {tab === "hair" && (<>
          <p className="py-1 text-[11px] text-mauve">單件髮型直接加入；整套髮型可快速套用。也可從素材庫逐件混搭。</p>
          <Row className="pb-1 pt-1" >
            <AddCard label="新增髮型" testid="add-hair" onClick={() => onNew("hair")} />
            {hairs.filter((h) => !cat || h.category === cat).map((h) => <AssetCard key={h.id} a={h} on={!value.hair_config && value.hair === h.id} onPick={() => {const parts=(h.config as HairConfig).parts; if(parts.length===1)add(parts);else {onChange({...value,hair:h.id,hair_config:null});onSelectHair(null);}}} onEdit={h.builtin ? undefined : () => onEdit(h)} />)}
            <AssetCard a={{ id: NO_HAIR_ID, name: "不戴頭髮" }} on={!current.length} onPick={() => {onChange({ ...value, hair: NO_HAIR_ID,hair_config:null });onSelectHair(null);}} />
          </Row>
          <H>逐件加入髮件</H><select aria-label="選擇髮型來源" data-testid="hair-source" value={source} onChange={e=>setSource(e.target.value)} className="w-full rounded-lg bg-velvet p-2"><option value="">選擇素材</option>{hairs.map(h=><option key={h.id} value={h.id}>{h.name}</option>)}</select>
          {sourceHair&&<div className="mt-1 flex flex-wrap gap-1">{(sourceHair.config as HairConfig).parts.map(p=><button type="button" key={p.id} data-add-hair-part={p.id} disabled={current.length>=16} className="chip rounded-full px-3 py-1.5" onClick={()=>add([p])}>＋{p.label}</button>)}</div>}
          <H>已使用髮件（{current.length}/16）</H>
          <div className="space-y-1" data-testid="worn-hair-parts">{current.map((p,i)=><div key={p.id} className="flex items-center gap-1 rounded-xl bg-white/5 p-1.5"><button type="button" data-worn-hair={p.id} className={pill(selectedHair===p.id)} onClick={()=>onSelectHair(p.id)}>{p.label}</button><span className="flex-1 text-[10px] text-mauve">{HAIR_LAYER_LABEL[p.layer]}</span><button type="button" aria-label={p.hidden?"顯示髮件":"隱藏髮件"} className="chip rounded-full p-1.5" onClick={()=>onHairPatch(p.id,{hidden:!p.hidden})}>{p.hidden?<IconEyeOff/>:<IconEye/>}</button><button type="button" aria-label="髮件上移" disabled={i===0} className="chip rounded-full px-2 py-1" onClick={()=>{const a=[...current];[a[i-1],a[i]]=[a[i],a[i-1]];changeParts(a);}}>↑</button><button type="button" aria-label="髮件下移" disabled={i===current.length-1} className="chip rounded-full px-2 py-1" onClick={()=>{const a=[...current];[a[i+1],a[i]]=[a[i],a[i+1]];changeParts(a);}}>↓</button><button type="button" aria-label="移除髮件" className="chip rounded-full p-1.5" onClick={()=>{changeParts(current.filter(q=>q.id!==p.id));if(selectedHair===p.id)onSelectHair(null);}}><IconClose/></button></div>)}</div>
          {selected&&<div className="mt-2 rounded-xl bg-white/5 p-2"><div className="flex flex-wrap gap-1"><button type="button" className={pill(hairTool==="place")} onClick={()=>setHairTool("place")}>位置</button><button type="button" data-testid="hair-mesh" className={pill(hairTool==="mesh")} onClick={()=>setHairTool("mesh")}>變形</button><button type="button" className="chip rounded-full px-3" onClick={()=>onHairPatch(selected.id,{mesh:undefined})}>重設變形</button></div><p className="py-1 text-[11px] text-mauve">在角色上拖動髮件或網格；雙指縮放人物。</p><div className="flex flex-wrap gap-1">{(["back","mid","front"] as const).map(l=><button type="button" key={l} className={pill(selected.layer===l)} onClick={()=>onHairPatch(selected.id,{layer:l})}>{HAIR_LAYER_LABEL[l]}</button>)}<button type="button" className="chip rounded-full px-3 py-1" onClick={()=>onHairPatch(selected.id,{w:selected.w*1.03})}>加闊</button><button type="button" className="chip rounded-full px-3 py-1" onClick={()=>onHairPatch(selected.id,{w:selected.w/1.03})}>收窄</button><button type="button" className="chip rounded-full px-3 py-1" onClick={()=>onHairPatch(selected.id,{h:selected.h*1.03})}>拉長</button><button type="button" className="chip rounded-full px-3 py-1" onClick={()=>onHairPatch(selected.id,{h:selected.h/1.03})}>縮短</button><button type="button" className="chip rounded-full px-3 py-1" onClick={()=>onSelectHair(null)}>完成</button></div></div>}
          {current.length>0&&<button type="button" data-testid="save-hair-combo" disabled={busy} onClick={onSaveHair} className="btn-jewel mt-2 w-full rounded-full py-2">保存目前髮件為新髮型</button>}
        </>)}
        {tab === "color" && (
          <>
            <div className="flex items-center justify-between pb-1.5 text-[11.5px]"><span className="text-mauve">所有髮型共用；沒有染色遮罩的髮型會自動分辨挑染</span><span className="text-gold-soft">{preset?.label ?? "自訂"}</span></div>
            <div className="flex justify-between gap-1" data-testid="hair-colors">
              {HAIR_COLORS.map((c) => {
                const on = preset?.id === c.id;
                return (
                  <button key={c.id} type="button" data-color={c.id} aria-label={c.label} aria-pressed={on} onClick={() => onChange({ ...value, hair_color: c.id, accent_color: null })} className={`relative grid aspect-square w-[12.5%] place-items-center rounded-full border ${on ? "border-gold-soft outline-2 outline-offset-1 outline-gold-soft" : "border-white/40"}`} style={{ background: `linear-gradient(135deg, ${c.swatch[0]} 58%, ${c.swatch[1]} 58%)` }}>
                    {on && <span className="text-[13px] text-white drop-shadow">✓</span>}
                  </button>
                );
              })}
            </div>
            <div className="mt-2.5 flex gap-2">
              <Swatch label="主髮色" testid="color-main" value={resolved.main ? rgbToHex(resolved.main) : null} fallback="#644950" onPick={(hex) => onChange({ ...value, hair_color: hex, accent_color: value.accent_color ?? (resolved.accent ? rgbToHex(resolved.accent) : "original") })} />
              <Swatch label="挑染色" testid="color-accent" value={resolved.accent ? rgbToHex(resolved.accent) : null} fallback="#e0899f" onPick={(hex) => onChange({ ...value, accent_color: hex })} />
              <Swatch label="髮尾漸層" testid="color-tip" value={value.tip_color} fallback="#f2a7c3" onPick={(hex) => onChange({ ...value, tip_color: hex })} onClear={() => onChange({ ...value, tip_color: null })} />
            </div>
          </>
        )}
        {tab === "head" && (
          <Row className="pb-1 pt-1">
            <AddCard label="新增頭部" testid="add-head" onClick={() => onNew("head")} />
            {heads.map((h) => <AssetCard key={h.id} a={h} on={value.head === h.id} onPick={() => onChange({ ...value, head: h.id })} onEdit={h.builtin ? undefined : () => onEdit(h)} />)}
          </Row>
        )}
      </div>
    </div>
  );
}

// ───── 姿勢 ─────
export function PosePanel({ rig, pose, front, onPose, onFront, show, setShow, active, setActive, handles }: {
  rig: Rig; pose: Pose; front: FrontPart[]; onPose: (p: Pose, front?: FrontPart[]) => void; onFront: (f: FrontPart[]) => void; show: boolean; setShow: (v: boolean) => void; active: string | null; setActive: (id: string | null) => void; handles: PoseHandle[];
}) {
  const bones = boneMap(rig);
  const preset = POSE_PRESETS.find((p) => samePose(rig, p.pose, pose));
  const handle = handles.find((h) => h.id === active);
  // 控制點對應的骨骼；IK 末端同時顯示上、中兩節
  const ids = handle ? (handle.kind === "ik" ? [handle.upper!, handle.mid!] : [handle.bone]) : active && bones.has(active) ? [active] : [];
  const set = (key: string, v: number) => onPose(clampPose(rig, { ...pose, [key]: v }));
  const resetBones = (list: string[]) => { const next = { ...pose }; for (const b of list) { delete next[b]; delete next[b + ".x"]; delete next[b + ".y"]; } onPose(clampPose(rig, next)); };
  const hairBones = rig.bones.filter((b) => b.id.startsWith("hair_") || b.id.startsWith("hp_")).map((b) => b.id);
  const toggleFront = (k: FrontPart) => onFront(front.includes(k) ? front.filter((x) => x !== k) : [...front, k]);
  return (
    <div className="scrollbar-none -mx-3 h-full overflow-y-auto overscroll-contain px-3 pb-2 text-[12.5px]" data-testid="pose-panel">
      <Row className="pb-2" >
        {POSE_PRESETS.map((p) => <button key={p.id} type="button" data-pose={p.id} onClick={() => onPose(p.pose, p.front ?? [])} className={pill(preset?.id === p.id)}>{p.label}</button>)}
      </Row>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" data-testid="toggle-skeleton" aria-pressed={show} onClick={() => setShow(!show)} className={pill(show)}>{show ? "隱藏骨架" : "顯示骨架"}</button>
        <button type="button" aria-pressed={front.includes("hand_r")} onClick={() => toggleFront("hand_r")} className={pill(front.includes("hand_r"))}>右手在衣服前</button>
        <button type="button" aria-pressed={front.includes("hand_l")} onClick={() => toggleFront("hand_l")} className={pill(front.includes("hand_l"))}>左手在衣服前</button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-mauve">重設</span>
        <button type="button" data-testid="pose-reset" onClick={() => onPose({}, [])} className="chip rounded-full px-2.5 py-1">全部</button>
        {BONE_GROUPS.map((g) => <button key={g.id} type="button" data-reset={g.id} onClick={() => resetBones(g.id === "hair" ? hairBones : g.bones)} className="chip rounded-full px-2.5 py-1">{g.label}</button>)}
      </div>
      <div className="mt-2.5 rounded-2xl bg-white/5 p-2.5">
        <div className="flex items-center gap-2">
          <select aria-label="選擇關節" data-testid="bone-select" value={ids[ids.length - 1] ?? ""} onChange={(e) => setActive(e.target.value || null)} className="h-8 min-w-0 flex-1 rounded-full bg-velvet px-3 text-[12.5px] text-cream ring-1 ring-gold/50">
            <option value="">{show ? "拖動角色上的圓點，或在此選擇關節" : "選擇關節微調"}</option>
            {rig.bones.filter((b) => b.min_angle !== b.max_angle || b.max_offset).map((b) => <option key={b.id} value={b.id}>{BONE_LABEL[b.id] ?? (b.id.startsWith("hp_") ? "髮束 " + b.id.slice(3) : b.id)}</option>)}
          </select>
          {ids.length > 0 && <button type="button" data-testid="bone-reset" onClick={() => resetBones(ids)} className="chip h-8 shrink-0 rounded-full px-3">重設這個關節</button>}
        </div>
        {ids.map((id) => {
          const b = bones.get(id);
          if (!b) return null;
          const v = pose[id] ?? 0;
          return (
            <div key={id} className="mt-2">
              <label className="grid grid-cols-[4.2rem_1fr_2.8rem] items-center gap-2">
                <span>{BONE_LABEL[id] ?? "髮束"}</span>
                <input type="range" data-bone={id} min={b.min_angle} max={b.max_angle} step={0.5} value={v} onChange={(e) => set(id, Number(e.target.value))} className="w-full" />
                <span className="text-right tabular-nums">{v > 0 ? "+" : ""}{v}°</span>
              </label>
              {b.max_offset && (["x", "y"] as const).map((axis, i) => (
                <label key={axis} className="mt-1 grid grid-cols-[4.2rem_1fr_2.8rem] items-center gap-2 text-mauve">
                  <span>{axis === "x" ? "左右位置" : "上下位置"}</span>
                  <input type="range" data-bone={`${id}.${axis}`} min={-b.max_offset![i]} max={b.max_offset![i]} step={1} value={pose[`${id}.${axis}`] ?? 0} onChange={(e) => set(`${id}.${axis}`, Number(e.target.value))} className="w-full" />
                  <span className="text-right tabular-nums">{pose[`${id}.${axis}`] ?? 0}</span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
