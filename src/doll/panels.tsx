// 換裝頁底部面板：衣服、圖層（已穿衣物）、外貌、姿勢。面板保持矮小，角色始終可見。
import { ReactNode, useMemo, useState } from "react";
import { Pose, Rig, applyMat, boneMap, clampPose, jointPositions, samePose, solve } from "../../shared/avatarRig";
import { BONE_LABEL, BUILTIN_HAIRS, BUILTIN_HEADS, DollAsset, FrontPart, HairCat, HairConfig, HairPart, HAIR_CATS, HAIR_CAT_LABEL, HAIR_COLORS, NO_HAIR_ID, POSE_PRESETS, hairCatOf, hairPartName, refUrl, resolveHairColors, rgbToHex } from "../../shared/avatarV2";
import { ATTACHABLE_BONES, FOLLOWS, Follow, Piece, SLEEVE_ROT_LIMIT, SLOT_LABEL, SLOT_SKIN, WearOpts, slotFor } from "../../shared/doll";
import { Garment, displayName, imageUrl } from "../api";
import { IconClose, IconEye, IconEyeOff, IconGrip, IconPencil, IconPlus, IconSearch, IconTrash } from "../components/icons";
import { SortableList } from "../components/Sortable";
import { TransparentImage } from "../components/TransparentImage";
import { WardrobeImage } from "../components/WardrobeImage";
import { useTaxonomy } from "../taxonomy";
import { RigInfo } from "../../shared/garmentMesh";
import { Appearance, BUILTIN_THUMB, GarmentLite, Resolved, wearHairPart } from "./model";
import { DRAG_MODES, DragMode, PoseControl, REGIONS, Region, adjustable, jointLabel, jointTitle, regionBones, regionOf } from "../../shared/poseControls";

export const pill = (on: boolean) => `shrink-0 rounded-full px-3 py-1.5 text-[12.5px] ${on ? "chip-on" : "chip"}`;
const H = ({ children }: { children: ReactNode }) => <h3 className="mb-1.5 mt-3 text-[11.5px] tracking-[0.12em] text-gold-soft first:mt-0">{children}</h3>;
const Row = ({ children, className = "" }: { children: ReactNode; className?: string }) => <div className={`scrollbar-none -mx-3 flex gap-1.5 overflow-x-auto px-3 ${className}`}>{children}</div>;

// ───── 衣服 ─────
/** 已拆出的套裝部件（衣服選單內可以直接選擇；不是新衣物，不影響衣櫃統計） */
export interface PieceEntry { g: Garment; piece: Piece }
const PIECE_CAT = "套裝部件";
/** 部件屬於哪個大分類：按部件的圖層位置對應衣櫃分類 */
const pieceInCat = (p: Piece, cat: string) => slotFor(cat) === p.slot;
export function ClothesPanel({ garments, wornIds, wornKeys, pending, onToggle, pieces, onPiece }: { garments: Garment[] | null; wornIds: Set<string>; wornKeys: Set<string>; pending: Set<string>; onToggle: (g: Garment) => void; pieces: PieceEntry[]; onPiece: (e: PieceEntry) => void }) {
  const [cat, setCat] = useState("");
  const [sub, setSub] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState(false);
  const tax = useTaxonomy();
  // 大分類／子分類直接來自衣櫃現有資料（按分類字典的次序排列），不另外寫死
  const cats = useMemo(() => {
    const have = new Set((garments || []).map((g) => g.category || "").filter(Boolean));
    const order = tax.categories.map((c) => c.name);
    return [...have].sort((a, b) => (order.indexOf(a) < 0 ? 999 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 999 : order.indexOf(b)));
  }, [garments, tax]);
  const subs = useMemo(() => {
    if (!cat || cat === PIECE_CAT) return [];
    const have = new Set((garments || []).filter((g) => g.category === cat).map((g) => g.subcategory || "").filter(Boolean));
    const order = tax.categories.find((c) => c.name === cat)?.subs.map((s) => s.name) ?? [];
    return [...have].sort((a, b) => (order.indexOf(a) < 0 ? 999 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 999 : order.indexOf(b)));
  }, [garments, cat, tax]);
  const needle = q.trim().toLowerCase();
  const list = useMemo(() => cat === PIECE_CAT ? [] : (garments || []).filter((g) => (!cat || g.category === cat) && (!sub || g.subcategory === sub) && (!needle || [g.name, g.brand, g.subcategory, g.style, g.primary_color].some((v) => (v || "").toLowerCase().includes(needle)))), [garments, cat, sub, needle]);
  const pieceList = useMemo(() => pieces.filter(({ g, piece }) => {
    if (needle) return [piece.name, g.name, SLOT_LABEL[piece.slot]].some((v) => v.toLowerCase().includes(needle));
    if (cat === PIECE_CAT) return true;
    if (!cat) return false; // 「全部」只列出原本的衣物；部件在相應分類或「套裝部件」內出現
    return pieceInCat(piece, cat) && (!sub || piece.name.includes(sub) || sub.includes(piece.name.replace(/（.*）/, "")));
  }), [pieces, cat, sub, needle]);
  const pickCat = (c: string) => { setCat(c); setSub(""); };
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 pb-1.5">
        <button type="button" aria-label="搜尋衣物" aria-pressed={search} onClick={() => { setSearch(!search); setQ(""); }} className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[15px] ${search ? "chip-on" : "chip"}`}><IconSearch /></button>
        {search ? (
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="名稱、品牌、顏色、部件…" aria-label="搜尋" className="h-8 min-w-0 flex-1 rounded-full bg-white px-3 text-[13px] text-ink ring-1 ring-gold focus:outline-none" />
        ) : (
          <div className="scrollbar-none -mr-3 flex min-w-0 flex-1 gap-1.5 overflow-x-auto pr-3" data-testid="doll-cats">
            {["", ...cats, ...(pieces.length ? [PIECE_CAT] : [])].map((c) => <button key={c || "all"} type="button" data-cat={c || "all"} onClick={() => pickCat(c)} className={pill(cat === c)}>{c || "全部"}</button>)}
          </div>
        )}
      </div>
      {!search && subs.length > 1 && (
        <div className="scrollbar-none -mx-3 flex gap-1 overflow-x-auto px-3 pb-1.5" data-testid="doll-subcats">
          {["", ...subs].map((c) => <button key={c || "all"} type="button" data-subcat={c || "all"} onClick={() => setSub(c)} className={`shrink-0 rounded-full px-2.5 py-1 text-[11.5px] ${sub === c ? "chip-on" : "bg-white/5 text-cream/80"}`}>{c || "全部"}</button>)}
        </div>
      )}
      <div className="scrollbar-none -mx-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2">
        {!garments ? <p className="py-6 text-center text-[12px] text-mauve">載入衣櫃中…</p> : list.length === 0 && pieceList.length === 0 ? (
          <p className="py-6 text-center text-[12px] leading-relaxed text-mauve">{garments.length ? "沒有符合的衣物" : "衣櫃未有已入庫而且有透明圖的衣物"}</p>
        ) : (
          <div className="grid grid-cols-4 gap-x-2 gap-y-2.5 sm:grid-cols-6" data-testid="doll-picker">
            {pieceList.map((e) => {
              const key = e.g.id + "#" + e.piece.id, on = wornKeys.has(key);
              return (
                <button key={key} type="button" data-piece-entry={key} aria-pressed={on} onClick={() => onPiece(e)} className="relative block text-left">
                  <div className={`arch arch-base relative aspect-[3/4] ${on ? "outline-2 outline-offset-1 outline-gold-soft" : ""}`}>
                    <div className="absolute inset-0 overflow-hidden px-[8%] pb-[8%] pt-[18%]" style={{ borderRadius: "inherit" }}><PieceThumb g={e.g} piece={e.piece} /></div>
                  </div>
                  {on && <span className="btn-jewel absolute -left-0.5 -top-0.5 grid h-5 w-5 place-items-center rounded-full text-[10px]">✓</span>}
                  <span className="absolute -right-0.5 -top-0.5 rounded-full bg-gold px-1 text-[8.5px] font-bold leading-[13px] text-ink">部件</span>
                  <div className="truncate pt-1 text-center text-[10.5px] text-cream/90">{e.piece.name}</div>
                </button>
              );
            })}
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

/**
 * 部件縮圖：上傳的透明圖直接顯示；由原圖拆出的部件＝衣物縮圖裁出部件範圍（用快取的縮圖，不讀高清圖）。
 * （縮圖不套用選取遮罩，只作辨認；穿上後使用真正的部件圖。）
 */
export function PieceThumb({ g, piece }: { g: GarmentLite; piece: Piece }) {
  const [ar, setAr] = useState<number | null>(null);
  if (piece.file) return <img src={refUrl(piece.file)} alt="" loading="lazy" className="h-full w-full object-contain" />;
  const [x0, y0, x1, y1] = piece.box, bw = Math.max(0.01, x1 - x0), bh = Math.max(0.01, y1 - y0);
  const r = ar ? bw / (bh * ar) : bw / bh, wide = r >= 0.75;
  return (
    <span className="grid h-full w-full place-items-center">
      <span className="relative block overflow-hidden" style={{ aspectRatio: String(r), width: wide ? "100%" : "auto", height: wide ? "auto" : "100%", maxWidth: "100%", maxHeight: "100%", opacity: ar ? 1 : 0 }}>
        <WardrobeImage src={imageUrl(g.transparent_image_id)} alt="" onLoad={(e: { currentTarget: HTMLImageElement }) => setAr(e.currentTarget.naturalHeight / Math.max(1, e.currentTarget.naturalWidth))} className="absolute" style={{ width: `${100 / bw}%`, height: `${100 / bh}%`, left: `${(-x0 / bw) * 100}%`, top: `${(-y0 / bh) * 100}%`, maxWidth: "none" }} />
      </span>
    </span>
  );
}

// ───── 圖層（已穿衣物） ─────
export interface LayerGroupOps { onHideGroup: (gid: string, hide: boolean) => void; onRemoveGroup: (gid: string) => void }
type LayerRow = { id: string; r: Resolved; group?: { gid: string; members: Resolved[] } };
/** 圖層的名稱：套裝部件用部件自己的名稱 */
export const layerName = (r: Resolved) => (r.piece ? r.piece.name : displayName(r.garment as Garment));
export function LayersPanel({ items, selected, onSelect, onReorder, onHide, onRemove, onClear, hints, onHideGroup, onRemoveGroup }: {
  items: Resolved[]; selected: string | null; onSelect: (id: string | null) => void; onReorder: (ids: string[]) => void; onHide: (id: string) => void; onRemove: (id: string) => void; onClear: () => void; hints: string[];
} & LayerGroupOps) {
  /** 收起的套裝群組（只影響顯示；圖層次序仍然是每個部件獨立） */
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // 同一套裝同時穿著兩個或以上部件＝一個群組
  const groups = useMemo(() => {
    const m = new Map<string, Resolved[]>();
    for (const r of items) if (r.piece) m.set(r.garment.id, [...(m.get(r.garment.id) ?? []), r]);
    for (const [k, v] of m) if (v.length < 2) m.delete(k);
    return m;
  }, [items]);
  // 清單由上到下＝由外到內（與 Photoshop 圖層相同）。收起的群組以最外層部件的位置顯示一行。
  const rows = useMemo(() => {
    const out: LayerRow[] = [], shown = new Set<string>();
    for (const r of [...items].reverse()) {
      const gid = r.piece && groups.has(r.garment.id) && folded.has(r.garment.id) ? r.garment.id : null;
      if (!gid) { out.push({ id: r.key, r }); continue; }
      if (shown.has(gid)) continue;
      shown.add(gid);
      out.push({ id: "grp:" + gid, r, group: { gid, members: groups.get(gid)! } });
    }
    return out;
  }, [items, groups, folded]);
  const fold = (gid: string) => setFolded((cur) => { const n = new Set(cur); if (n.has(gid)) n.delete(gid); else n.add(gid); return n; });
  if (!items.length) return <p className="py-8 text-center text-[12px] leading-relaxed text-mauve">角色仍未穿上衣物。<br />到「衣服」點選衣物，可以自由疊穿多件。</p>;
  const reorder = (ids: string[]) => {
    // 收起的群組展開回各部件（保持它們原本的相對次序），再交回由內到外的次序
    const flat: string[] = [];
    for (const id of ids) {
      if (!id.startsWith("grp:")) { flat.push(id); continue; }
      const gid = id.slice(4);
      for (const r of [...items].reverse()) if (r.piece && r.garment.id === gid) flat.push(r.key);
    }
    onReorder(flat.reverse());
  };
  return (
    <div className="scrollbar-none -mx-3 h-full overflow-y-auto overscroll-contain px-3 pb-2" data-testid="layers-panel">
      <div className="mb-1.5 flex items-center justify-between text-[11.5px] text-mauve">
        <span>已穿 {items.length} 件｜上面的在外層，按住 ☰ 拖動排序</span>
        <button type="button" data-testid="clear-all" onClick={onClear} className="chip rounded-full px-2.5 py-1 text-[11.5px]">全部脫下</button>
      </div>
      {hints.map((h) => <p key={h} role="note" className="mb-1.5 rounded-xl bg-white/5 px-2.5 py-1.5 text-[11px] leading-snug text-gold-soft">提示：{h}</p>)}
      {groups.size > 0 && (
        <div className="mb-1.5 space-y-1" data-testid="layer-groups">
          {[...groups].map(([gid, members]) => {
            const allHidden = members.every((m) => m.worn.hidden);
            return (
              <div key={gid} data-layer-group={gid} className="flex items-center gap-1.5 rounded-xl bg-white/5 px-2 py-1 text-[11.5px]">
                <button type="button" aria-expanded={!folded.has(gid)} onClick={() => fold(gid)} className="flex min-w-0 flex-1 items-center gap-1 text-left text-gold-soft">
                  <span className="text-[10px]">{folded.has(gid) ? "▸" : "▾"}</span><span className="truncate">{displayName(members[0].garment as Garment)}（{members.length} 個部件）</span>
                </button>
                <button type="button" aria-label={allHidden ? "顯示整套" : "隱藏整套"} onClick={() => onHideGroup(gid, !allHidden)} className="grid h-7 w-7 place-items-center text-[15px]">{allHidden ? <IconEyeOff /> : <IconEye />}</button>
                <button type="button" aria-label="脫下整套部件" onClick={() => onRemoveGroup(gid)} className="grid h-7 w-7 place-items-center text-[13px]"><IconClose /></button>
              </div>
            );
          })}
          <p className="px-1 text-[10.5px] leading-snug text-mauve">群組只方便管理；每個部件仍可以獨立排序、隱藏及調整（例如頭飾在頭髮前、袖套在其他衣物中間）。</p>
        </div>
      )}
      <SortableList<LayerRow>
        items={rows}
        onReorder={reorder}
        className="space-y-1.5"
        render={({ r, group }, handle, dragging) => {
          if (group) {
            const hidden = group.members.every((m) => m.worn.hidden);
            return (
              <div data-layer={"grp:" + group.gid} className={`flex items-center gap-2 rounded-2xl py-1 pl-1.5 pr-1.5 chip ${dragging ? "opacity-70" : ""} ${hidden ? "opacity-60" : ""}`}>
                <button type="button" {...handle} className="grid h-9 w-7 shrink-0 place-items-center text-[16px] opacity-80"><IconGrip /></button>
                <button type="button" onClick={() => fold(group.gid)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <span className="relative h-10 w-8 shrink-0 overflow-hidden rounded-lg bg-white/85"><TransparentImage src={imageUrl(r.garment.transparent_image_id)} alt="" className="absolute inset-0 h-full w-full object-contain" /></span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px]">{displayName(r.garment as Garment)}</span>
                    <span className="block text-[10.5px] opacity-75">套裝群組｜{group.members.length} 個部件（按此展開）</span>
                  </span>
                </button>
                <button type="button" aria-label={hidden ? "顯示整套" : "隱藏整套"} onClick={() => onHideGroup(group.gid, !hidden)} className="grid h-9 w-8 shrink-0 place-items-center text-[17px]">{hidden ? <IconEyeOff /> : <IconEye />}</button>
                <button type="button" aria-label="脫下整套部件" onClick={() => onRemoveGroup(group.gid)} className="grid h-9 w-8 shrink-0 place-items-center text-[15px]"><IconClose /></button>
              </div>
            );
          }
          const on = r.key === selected;
          const variant = r.worn.variant && r.template?.data?.variants[r.worn.variant] ? r.template.data.variants[r.worn.variant].name : "";
          const info = r.piece
            ? [SLOT_LABEL[r.piece.slot], "部件", r.opts.bone && r.opts.bone !== "world" ? "附接" + (BONE_LABEL[r.opts.bone] ?? r.opts.bone) : "", r.piece.fit ? "已校正" : "未校正", r.from === "override" ? "已個別調整" : ""]
            : [SLOT_LABEL[r.worn.slot], variant, r.from === "override" ? "已個別調整" : r.from === "template" ? "已校正" : ""];
          return (
            <div data-layer={r.key} className={`flex items-center gap-2 rounded-2xl py-1 pl-1.5 pr-1.5 ${on ? "chip-on" : "chip"} ${dragging ? "opacity-70" : ""} ${r.worn.hidden ? "opacity-60" : ""}`}>
              <button type="button" {...handle} className="grid h-9 w-7 shrink-0 place-items-center text-[16px] opacity-80"><IconGrip /></button>
              <button type="button" onClick={() => onSelect(on ? null : r.key)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <span className="relative h-10 w-8 shrink-0 overflow-hidden rounded-lg bg-white/85">
                  {/* 套裝部件：用已製作好的部件圖（只在記憶體，不另外讀取高清圖） */}
                  {r.piece && r.image ? <img src={r.piece.file ? refUrl(r.piece.file) : r.image} alt="" data-piece-thumb={r.piece.id} className="absolute inset-0 h-full w-full object-contain p-0.5" /> : <TransparentImage src={imageUrl(r.garment.transparent_image_id)} alt="" className="absolute inset-0 h-full w-full object-contain" />}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px]" data-layer-name>{layerName(r)}</span>
                  <span className="block truncate text-[10.5px] opacity-75">{info.filter(Boolean).join("｜")}{r.piece ? `｜${displayName(r.garment as Garment)}` : ""}</span>
                </span>
              </button>
              <button type="button" aria-label={r.worn.hidden ? "顯示" : "暫時隱藏"} aria-pressed={r.worn.hidden} onClick={() => onHide(r.key)} className="grid h-9 w-8 shrink-0 place-items-center text-[17px]">{r.worn.hidden ? <IconEyeOff /> : <IconEye />}</button>
              <button type="button" aria-label="脫下" onClick={() => onRemove(r.key)} className="grid h-9 w-8 shrink-0 place-items-center text-[15px]"><IconClose /></button>
            </div>
          );
        }}
      />
    </div>
  );
}

// ───── 對比 ─────
export type CompareKind = "mesh" | "mask" | "rig";
export const COMPARE_LABEL: Record<CompareKind, string> = { mesh: "變形前", mask: "未套用遮罩", rig: "未套用骨架變形" };
/** 對比按鈕：輕按切換；按住＝暫時顯示對比，放手即返回目前效果。期間仍可縮放及移動畫面。 */
export function CompareButton({ kind, on, set, className = "" }: { kind: CompareKind; on: boolean; set: (v: boolean) => void; className?: string }) {
  const [t0, setT0] = useState<{ at: number; was: boolean } | null>(null);
  return (
    <button type="button" data-testid="compare" data-compare={kind} aria-pressed={on}
      onPointerDown={() => { setT0({ at: Date.now(), was: on }); if (!on) set(true); }}
      onPointerUp={() => { if (!t0) return; const held = Date.now() - t0.at > 350; set(held ? false : !t0.was); setT0(null); }}
      onPointerCancel={() => { if (t0) { set(t0.was); setT0(null); } }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); set(!on); } }}
      className={`select-none touch-none ${pill(on)} ${className}`}>{on ? `對比中：${COMPARE_LABEL[kind]}` : "對比（可按住）"}</button>
  );
}

// ───── 已選衣物的校正 ─────
export type FitTool = "place" | "mesh" | "mask" | "follow" | "wear";
/** 衣物怎樣跟隨角色：fixed＝固定完整原圖（不跟隨骨架）；body＝整件跟隨身體（不拆袖）；auto＝自動拆袖跟隨手臂 */
export type WearMode = "fixed" | "body" | "auto";
export function wearMode(opts: WearOpts): WearMode {
  if (opts.bone === "world") return "fixed";
  return opts.follow === "none" || opts.bone ? "body" : "auto";
}
/** 編輯視圖：worn＝角色穿著預覽；source＝衣物原圖（平放、沒有角色）；mesh＝穿著預覽加上部件顏色及變形網格 */
export type GarmentView = "worn" | "source" | "mesh";
export interface MaskTool { mode: "hide" | "behind" | "restore"; size: number }
/** 部件筆刷：0＝衣身、1＝右袖、2＝左袖 */
export interface PartTool { label: number; size: number }
export interface FitDelta { dx?: number; dy?: number; scale?: number; rot?: number; wide?: number; tall?: number; /** 直接指定闊度／角度（滑桿） */ w?: number; rotation?: number }
/** 這件衣物目前怎樣跟隨骨架（一句說明） */
export function rigSummary(info: RigInfo | null, skin: string): string {
  if (!info) return "";
  if (info.mode === "rigid") return "整件一起移動，保持完整原圖。";
  if (skin === "legs") return info.legs ? "褲管／襪／鞋各自跟隨兩條腿，每一邊都是完整的一塊。" : "整件跟隨骨盆。";
  const sides = [info.sleeve_r && "右袖", info.sleeve_l && "左袖"].filter(Boolean).join("、");
  if (info.fallback) return "自動分辨的結果不完整，已改回完整衣物顯示（沒有拆袖）。可以用筆刷人工標記袖子。";
  if (!sides) return info.source === "whole" ? "整件衣物（不拆袖）：衣身跟隨上身彎曲，保持完整。" : info.unsure ? "未能可靠分辨袖子，現時以整件衣物顯示（保持完整）。可以用筆刷標記袖子。" : "沒有找到袖子：整件衣物跟隨上身，保持完整。";
  return `${info.source === "manual" ? "人工標記" : info.source === "zone" ? "按手臂位置估計" : "自動分辨"}：${sides}跟隨手臂${info.forearm ? "（連手肘）" : ""}，衣身保持完整。`;
}
const SIZE_MIN = Math.log(40), SIZE_MAX = Math.log(2400);
const VIEW_LABEL: [GarmentView, string][] = [["worn", "穿著預覽"], ["source", "衣物原圖"], ["mesh", "部件網格"]];
const TOOL_LABEL: [FitTool, string][] = [["place", "位置"], ["mesh", "變形"], ["mask", "遮罩"], ["follow", "骨架"], ["wear", "穿法"]];
const MODE_INFO: { id: WearMode; label: string; hint: string }[] = [
  { id: "fixed", label: "固定形狀", hint: "保留已校正的衣物圖片，固定在畫面上，不跟隨骨架。最穩定。" },
  { id: "body", label: "跟隨身體", hint: "整件衣物跟隨身體（或所附接的部位）移動及轉動，不拆袖，保持完整。" },
  { id: "auto", label: "跟隨手臂", hint: "袖子跟隨肩膊、手肘及手腕。分辨失敗時會自動保持完整衣物，不會斷開。" },
];
export function FitPanel({ onBind, onApplyBind, r, info, tool, setTool, compact, view, setView, compare, setCompare, busy, onFit, onMeshReset, onMode, onOpts, onAuto, onRestore, onSaveDefault, onRemove, onDone, onOrder, onVariant, onAddVariant, onDeleteVariant, onSavePose, onApplyPose, mask, setMask, onClearMask, part, setPart, hint, setHint, onParts, onResetSleeve, onSleeveAuto, onPoseFix, onFrame, onWhole, pieces, wornPieces, onOpenSplit, onWearPieces, onTogglePiece }: {
  /** 基準姿勢：true＝以目前姿勢設定，false＝清除 */
  onBind: (on: boolean) => void; onApplyBind: () => void;
  pieces: Piece[] | null; wornPieces: Set<string>; onOpenSplit: () => void; onWearPieces: (ids: string[], replace: boolean) => void; onTogglePiece: (id: string) => void;
  r: Resolved; info: RigInfo | null; tool: FitTool; setTool: (t: FitTool) => void; busy: boolean;
  compact?: boolean; view: GarmentView; setView: (v: GarmentView) => void; compare: boolean; setCompare: (v: boolean) => void; onFrame: () => void;
  part: PartTool; setPart: (p: PartTool) => void; hint: boolean; setHint: (v: boolean) => void; onParts: (v: string | null) => void; onResetSleeve: (label: 1 | 2) => void; onSleeveAuto: () => void; onPoseFix: () => void;
  onFit: (f: FitDelta) => void; onMeshReset: () => void; onMode: (m: WearMode) => void; onOpts: (o: Partial<WearOpts>) => void; onAuto: () => void; onRestore: () => void; onSaveDefault: () => void; onRemove: () => void; onDone: () => void;
  /** 返回完整原圖：清除手動網格、拆件及遮罩，改為固定原圖（位置保留） */
  onWhole: () => void;
  onOrder: (to: "top" | "up" | "down" | "bottom") => void; onVariant: (id: string | null) => void; onAddVariant: (withImage: boolean) => void; onDeleteVariant: (id: string) => void; onSavePose: () => void; onApplyPose: () => void;
  mask: MaskTool; setMask: (m: MaskTool) => void; onClearMask: () => void;
}) {
  const variants = Object.entries(r.template?.data?.variants ?? {});
  const skin = SLOT_SKIN[r.worn.slot];
  /** 骨架的進階設定（平時收起；正在標記袖子時自動展開） */
  const [advOpen, setAdv] = useState(false);
  const adv = advOpen || part.label >= 0 || skin === "rigid";
  const wm = wearMode(r.opts);
  const autoParts = skin === "upper" && wm === "auto";
  const modified = !!r.fit.mesh || !!r.mask || (!!r.parts && r.parts !== "whole") || wm !== "fixed" || !!r.opts.bind;
  const B = ({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) => <button type="button" aria-label={label} onClick={onClick} className="chip grid h-9 min-w-9 place-items-center rounded-full px-2.5 text-[14px]">{children}</button>;
  const FROM = { default: "自動估算的位置", template: "衣物預設位置", converted: "由舊角色換算，建議校正後存為預設", override: "已調整（只用於這個造型）" }[r.from];
  const rot = Math.round((((r.fit.rotation + 180) % 360 + 360) % 360 - 180) * 2) / 2;
  const views = (opts: GarmentView[], kind: CompareKind) => (
    <div className="mb-2 flex flex-wrap items-center gap-1.5" data-testid="garment-views">
      {VIEW_LABEL.filter(([v]) => opts.includes(v)).map(([v, label]) => <button key={v} type="button" data-gview={v} aria-pressed={view === v} onClick={() => setView(v)} className={pill(view === v)}>{label}</button>)}
      <CompareButton kind={kind} on={compare} set={setCompare} className="ml-auto" />
    </div>
  );
  const defaults = () => (
    <div className="mt-3 grid grid-cols-2 gap-2 border-t border-gold/20 pt-2.5">
      <button type="button" disabled={r.from !== "override"} data-testid="fit-restore" onClick={onRestore} className="chip h-9 rounded-full text-[12px] disabled:opacity-40">恢復衣物預設</button>
      <button type="button" disabled={busy || !!r.analysis.content.approximate} data-testid="fit-save-default" onClick={onSaveDefault} className="btn-jewel h-9 rounded-full text-[12px] disabled:opacity-40">{r.worn.variant ? "存為這個穿法的預設" : "存為衣物預設"}</button>
    </div>
  );
  const thumb = r.garment.thumb_image_id ?? r.garment.transparent_image_id;
  return (
    <div className="flex h-full flex-col" data-testid="fit-panel" data-active-tool={tool}>
      <div className="flex items-center gap-2 pb-2">
        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-xl bg-cream/90 ring-2 ring-gold-soft" data-testid="fit-thumb">
          {thumb && <img src={imageUrl(thumb)} alt="" className="absolute inset-0 h-full w-full object-contain p-0.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] text-gold-soft"><span className="rounded-full bg-gold/20 px-1.5 leading-[16px]">編輯中</span><span className="truncate text-mauve" data-testid="fit-from">{FROM}</span></div>
          <div className="truncate text-[13.5px] font-medium" data-testid="fit-name">{displayName(r.garment as Garment)}</div>
        </div>
        <button type="button" aria-label="畫面對準這件衣物" data-testid="fit-frame-view" onClick={onFrame} className="chip grid h-8 w-8 shrink-0 place-items-center rounded-full text-[14px]"><IconSearch /></button>
        <button type="button" aria-label="脫下" onClick={onRemove} className="chip grid h-8 w-8 shrink-0 place-items-center rounded-full text-[13px]"><IconTrash /></button>
        <button type="button" data-testid="fit-done" onClick={onDone} className="btn-jewel h-8 shrink-0 rounded-full px-3.5 text-[12.5px]">完成</button>
      </div>
      <Row className="pb-2">
        {TOOL_LABEL.map(([t, label]) => <button key={t} type="button" data-tool={t} aria-pressed={tool === t} onClick={() => setTool(t)} className={pill(tool === t)}>{label}</button>)}
      </Row>
      {compact ? (
        <div className="flex items-center gap-1.5" data-testid="fit-compact">
          {tool === "mask" ? (
            <>
              {([["hide", "隱藏"], ["behind", "身後"], ["restore", "還原"]] as const).map(([m, label]) => <button key={m} type="button" data-mask={m} aria-pressed={mask.mode === m} onClick={() => setMask({ ...mask, mode: m })} className={pill(mask.mode === m)}>{label}</button>)}
              <input type="range" aria-label="筆刷" min={2} max={60} value={mask.size} onChange={(e) => setMask({ ...mask, size: Number(e.target.value) })} className="min-w-0 flex-1" />
            </>
          ) : tool === "mesh" ? (
            <><span className="flex-1 text-[11px] text-mauve">拖動畫面上的網格點</span><button type="button" onClick={onMeshReset} className="chip h-9 rounded-full px-3 text-[12px]">重設變形</button></>
          ) : (
            <>
              <B label="縮小" onClick={() => onFit({ scale: 1 / 1.03 })}>－</B><B label="放大" onClick={() => onFit({ scale: 1.03 })}>＋</B>
              <B label="向左轉" onClick={() => onFit({ rot: -1 })}>↺</B><B label="向右轉" onClick={() => onFit({ rot: 1 })}>↻</B>
              <B label="前移一層" onClick={() => onOrder("up")}>前</B><B label="後移一層" onClick={() => onOrder("down")}>後</B>
            </>
          )}
        </div>
      ) : (
        <div className="scrollbar-none -mx-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3 text-[12.5px]" data-testid="fit-scroll">
          {tool === "place" && (
            <div data-testid="fit-quick">
              <label className="grid grid-cols-[2.6rem_1fr_3.2rem] items-center gap-2">
                <span>大小</span>
                <input type="range" data-testid="fit-size" min={SIZE_MIN} max={SIZE_MAX} step={0.004} value={Math.log(r.fit.w)} onChange={(e) => onFit({ w: Math.exp(Number(e.target.value)) })} className="w-full" />
                <span className="text-right tabular-nums">{Math.round(r.fit.w)}</span>
              </label>
              <label className="mt-1 grid grid-cols-[2.6rem_1fr_3.2rem] items-center gap-2">
                <span>旋轉</span>
                <input type="range" data-testid="fit-rot" min={-180} max={180} step={0.5} value={rot} onChange={(e) => onFit({ rotation: Number(e.target.value) })} className="w-full" />
                <span className="text-right tabular-nums">{rot}°</span>
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <B label="向左微調" onClick={() => onFit({ dx: -4 })}>←</B><B label="向右微調" onClick={() => onFit({ dx: 4 })}>→</B><B label="向上微調" onClick={() => onFit({ dy: -4 })}>↑</B><B label="向下微調" onClick={() => onFit({ dy: 4 })}>↓</B>
                <button type="button" onClick={onAuto} className="chip h-9 rounded-full px-3">自動對位</button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="fit-stretch">
                <span className="text-[11px] text-mauve">闊／高</span>
                <button type="button" data-stretch="wide" onClick={() => onFit({ wide: 1.03 })} className="chip h-8 rounded-full px-2.5">加闊</button>
                <button type="button" data-stretch="narrow" onClick={() => onFit({ wide: 1 / 1.03 })} className="chip h-8 rounded-full px-2.5">收窄</button>
                <button type="button" data-stretch="tall" onClick={() => onFit({ tall: 1.03 })} className="chip h-8 rounded-full px-2.5">拉長</button>
                <button type="button" data-stretch="short" onClick={() => onFit({ tall: 1 / 1.03 })} className="chip h-8 rounded-full px-2.5">縮短</button>
                {r.fit.sy && <button type="button" onClick={() => onFit({ tall: 1 / r.fit.sy! })} className="chip h-8 rounded-full px-2.5">原比例</button>}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-mauve">圖層</span>
                {([["top", "最前"], ["up", "前移"], ["down", "後移"], ["bottom", "最後"]] as const).map(([k, label]) => <button key={k} type="button" data-order={k} onClick={() => onOrder(k)} className="chip h-8 rounded-full px-2.5">{label}</button>)}
              </div>
              <p className="mt-2 text-[11px] leading-snug text-mauve">在角色上直接拖動衣物；右下角把手縮放、上方把手旋轉。雙指只會放大或移動畫面，不會改變衣物。</p>
            </div>
          )}
          {tool === "mesh" && (
            <>
              <p className="mb-2 text-[11px] leading-snug text-mauve">直接拖動畫面上的 16 個網格點，整件衣服會連續變形（不會斷開）。可以先雙指放大畫面再微調。</p>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" data-testid="mesh-reset" onClick={onMeshReset} disabled={!r.fit.mesh} className="chip h-9 rounded-full px-3 disabled:opacity-40">重設變形</button>
                <CompareButton kind="mesh" on={compare} set={setCompare} />
              </div>
              {wm === "auto" && r.fit.mesh && <p className="mt-2 text-[11px] leading-snug text-mauve">有手動網格時，自動拆袖會暫停（保留你的網格）。如要網格與手臂跟隨同時使用：在「骨架」按「以目前姿勢作為基準」。</p>}
            </>
          )}
          {tool === "mask" && (
            <>
              {views(["worn", "source"], "mask")}
              <div className="flex flex-wrap items-center gap-1.5" data-testid="mask-tools">
                {([["hide", "隱藏"], ["behind", "移到身後"], ["restore", "還原"]] as const).map(([m, label]) => <button key={m} type="button" data-mask={m} aria-pressed={mask.mode === m} onClick={() => setMask({ ...mask, mode: m })} className={pill(mask.mode === m)}>{label}</button>)}
                <button type="button" aria-pressed={hint} data-testid="mask-hint" onClick={() => setHint(!hint)} className={pill(hint)}>顯示已編輯位置</button>
              </div>
              <label className="mt-2 flex items-center gap-2">筆刷<input type="range" data-testid="mask-brush" min={2} max={60} value={mask.size} onChange={(e) => setMask({ ...mask, size: Number(e.target.value) })} className="flex-1" /></label>
              <button type="button" data-testid="mask-clear" onClick={onClearMask} disabled={!r.mask} className="chip mt-2 h-8 rounded-full px-3 disabled:opacity-40">還原整件（清除遮罩）</button>
              <p className="mt-2 text-[11px] leading-snug text-mauve">「隱藏」令該部分不顯示（例如後領內側）；「移到身後」令該部分畫在身體後面（例如外套內裡）。可以在角色身上塗，也可以切換到「衣物原圖」放大來塗；兩邊是同一份遮罩，原圖不會被修改。</p>
            </>
          )}
          {tool === "follow" && (
            <>
              <div className="grid grid-cols-3 gap-1.5" data-testid="wear-modes">
                {MODE_INFO.filter((m) => skin !== "rigid" || m.id !== "auto").map((m) => (
                  <button key={m.id} type="button" data-wear-mode={m.id} aria-pressed={wm === m.id} onClick={() => onMode(m.id)} className={`rounded-2xl px-2 py-2 text-left ${wm === m.id ? "chip-on" : "chip"}`}>
                    <div className="text-[12px] font-medium">{m.label}</div>
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-mauve" data-testid="rig-summary">{MODE_INFO.find((m) => m.id === wm)!.hint} {wm !== "fixed" && rigSummary(info, skin)}</p>
              {skin !== "rigid" && wm !== "fixed" && (
                <div className="mt-2 rounded-xl bg-white/5 p-2" data-testid="bind-pose">
                  <div className="flex items-center justify-between gap-2"><span className="text-[11.5px] text-gold-soft">基準姿勢</span>{r.opts.bind ? <span className="rounded-full bg-gold/25 px-2 text-[10.5px] leading-[18px] text-gold-soft">已設定</span> : <span className="text-[10.5px] text-mauve">靜止站姿</span>}</div>
                  <p className="mt-1 text-[11px] leading-snug text-mauve">{r.opts.bind ? "角色擺出基準姿勢時，衣物保持校正時的樣子；移動手臂時只按姿勢的差異跟隨（網格、袖子角度不會重複計算）。" : "先擺好適合這件衣服的手臂姿勢，用位置／變形把衣物調整好，再按下面的按鈕：之後移動手臂時由這個姿勢開始跟隨。"}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button type="button" data-testid="bind-set" onClick={() => onBind(true)} className={r.opts.bind ? "chip h-8 rounded-full px-3" : "btn-jewel h-8 rounded-full px-3 text-[12px]"}>{r.opts.bind ? "改用目前姿勢" : "以目前姿勢作為基準"}</button>
                    {r.opts.bind && <button type="button" data-testid="bind-apply" onClick={onApplyBind} className="chip h-8 rounded-full px-3">擺回基準姿勢</button>}
                    {r.opts.bind && <button type="button" data-testid="bind-clear" onClick={() => onBind(false)} className="chip h-8 rounded-full px-3">清除基準</button>}
                    {wm === "auto" && <CompareButton kind="rig" on={compare} set={setCompare} />}
                  </div>
                </div>
              )}
              <button type="button" data-testid="fit-whole" disabled={!modified} onClick={onWhole} className="chip mt-2 h-9 w-full rounded-full text-[12px] disabled:opacity-40">返回完整原圖（清除拆件、網格、遮罩及基準姿勢）</button>
              {(autoParts || (wm === "body" && skin !== "rigid")) && <button type="button" data-testid="rig-advanced" aria-expanded={adv} onClick={() => setAdv(!adv)} className="mt-2 flex w-full items-center justify-between rounded-xl bg-white/5 px-2.5 py-2 text-[12px] text-gold-soft"><span>進階設定（袖子分區、角度、跟隨範圍、附接位置）</span><span>{adv ? "▾" : "▸"}</span></button>}
              {autoParts && adv && (
                <>
                  <H>袖子範圍</H>
                  {views(["worn", "source", "mesh"], "rig")}
                  <div className="flex flex-wrap items-center gap-1.5" data-testid="part-tools">
                    {([[1, "右袖（畫面左）"], [2, "左袖（畫面右）"], [0, "衣身"]] as const).map(([l, label]) => <button key={l} type="button" data-part={l} aria-pressed={part.label === l} onClick={() => setPart({ ...part, label: l })} className={pill(part.label === l)}><span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: l === 1 ? "#ff4f9a" : l === 2 ? "#2dbeff" : "#fffaf6" }} />{label}</button>)}
                  </div>
                  {part.label >= 0 ? <button type="button" data-testid="part-stop" onClick={() => setPart({ ...part, label: -1 })} className="btn-jewel mt-2 h-8 rounded-full px-3 text-[12px]">完成標記（畫布回到拖動衣物）</button> : <p className="mt-1.5 text-[11px] text-mauve">揀選一個部件後，直接在畫面上塗出它的範圍；完整衣物一直顯示，顏色只是標記。</p>}
                  <label className="mt-2 flex items-center gap-2">筆刷<input type="range" data-testid="part-brush" min={2} max={60} value={part.size} onChange={(e) => setPart({ ...part, size: Number(e.target.value) })} className="flex-1" /></label>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <button type="button" data-testid="parts-auto" onClick={() => onParts("auto")} className={pill(!r.parts || r.parts === "auto")}>自動分辨</button>
                    <button type="button" data-testid="parts-whole" onClick={() => onParts("whole")} className={pill(r.parts === "whole")}>不拆袖</button>
                    <button type="button" data-testid="reset-sleeve-r" onClick={() => onResetSleeve(1)} className="chip rounded-full px-3 py-1.5">重設右袖</button>
                    <button type="button" data-testid="reset-sleeve-l" onClick={() => onResetSleeve(2)} className="chip rounded-full px-3 py-1.5">重設左袖</button>
                    <button type="button" aria-pressed={hint} data-testid="parts-hint" onClick={() => setHint(!hint)} className={pill(hint)}>部件顏色</button>
                  </div>
                  <H>袖子角度</H>
                  {([["sleeve_r", "右袖"], ["sleeve_l", "左袖"]] as const).map(([k, label]) => (
                    <label key={k} className="mt-1 grid grid-cols-[2.6rem_1fr_2.8rem] items-center gap-2">
                      <span>{label}</span>
                      <input type="range" data-sleeve={k} min={-SLEEVE_ROT_LIMIT} max={SLEEVE_ROT_LIMIT} step={1} value={r.opts[k] ?? 0} onChange={(e) => onOpts({ [k]: Number(e.target.value) })} className="w-full" />
                      <span className="text-right tabular-nums">{r.opts[k] ?? 0}°</span>
                    </label>
                  ))}
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button type="button" data-testid="sleeve-auto" onClick={onSleeveAuto} className="chip h-8 rounded-full px-3">自動貼合手臂</button>
                    <button type="button" onClick={() => onOpts({ sleeve_r: 0, sleeve_l: 0 })} className="chip h-8 rounded-full px-3">回復原本角度</button>
                  </div>
                  <H>袖子跟隨</H>
                  <div className="flex flex-wrap gap-1.5" data-testid="follow">
                    {([["auto", "自動"], ["upper", "只跟上臂"], ["full", "連手肘彎曲"]] as [Follow, string][]).map(([f, label]) => <button key={f} type="button" data-follow={f} onClick={() => onOpts({ follow: f, bone: null })} className={pill(r.opts.follow === f && !r.opts.bone)}>{label}</button>)}
                  </div>
                </>
              )}
              {wm === "body" && adv && (
                <>
                  <H>附接的部位</H>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => onOpts({ follow: "none", bone: null })} className={pill(!r.opts.bone)}>按分類</button>
                    {ATTACHABLE_BONES.filter((b) => b !== "world").map((b) => <button key={b} type="button" data-bone={b} onClick={() => onOpts({ follow: "none", bone: b })} className={pill(r.opts.bone === b)}>{BONE_LABEL[b] ?? b}</button>)}
                  </div>
                </>
              )}
              <H>前後關係</H>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" data-testid="opt-neck" aria-pressed={r.opts.neck} onClick={() => onOpts({ neck: !r.opts.neck })} className={pill(r.opts.neck)}>後領放在頸後</button>
                <button type="button" aria-pressed={r.opts.over_head} onClick={() => onOpts({ over_head: !r.opts.over_head })} className={pill(r.opts.over_head)}>蓋在頭髮上面</button>
              </div>
            </>
          )}
          {tool === "wear" && r.piece && (
            <p className="mb-2 rounded-xl bg-white/5 p-2 text-[11px] leading-snug text-mauve" data-testid="piece-info">這是「{displayName(r.garment as Garment)}」拆出來的部件「{r.piece.name}」，不是另一件衣物。按「存為衣物預設」會保存這個部件的預設位置。</p>
          )}
          {tool === "wear" && pieces && (
            <div className="mb-3 rounded-xl bg-white/5 p-2" data-testid="set-pieces">
              <div className="flex items-center justify-between"><span className="text-[11.5px] text-gold-soft">套裝拆件</span><button type="button" data-testid="open-split" onClick={onOpenSplit} className="chip rounded-full px-3 py-1 text-[12px]">{pieces.length ? "編輯拆件" : "拆件編輯器"}</button></div>
              {pieces.length ? (
                <>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">{pieces.map((p) => <button key={p.id} type="button" data-wear-piece={p.id} aria-pressed={wornPieces.has(p.id)} onClick={() => onTogglePiece(p.id)} className={pill(wornPieces.has(p.id))}>{wornPieces.has(p.id) ? "✓ " : "＋ "}{p.name}</button>)}</div>
                  <button type="button" data-testid="wear-all-pieces" onClick={() => onWearPieces(pieces.map((p) => p.id), true)} className="btn-jewel mt-2 h-8 w-full rounded-full text-[12px]">改為穿上全部部件（代替整件套裝）</button>
                </>
              ) : <p className="mt-1 text-[11px] leading-snug text-mauve">把套裝原圖拆成可以獨立穿著的部件（袖套、頸飾、頭飾…），原圖不會被修改。</p>}
            </div>
          )}
          {tool === "wear" && !r.piece && (
            <>
              <p className="mb-2 text-[11px] leading-snug text-mauve">同一件衣服可以保存不同穿著方式，例如外套打開／關上、襯衫收入裙內／放出。需要另一張圖的穿法可上傳透明圖。</p>
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
              <p className="mb-2 text-[11px] leading-snug text-mauve">先擺好姿勢並調整好衣服再保存；之後擺出相近姿勢時，畫面會提示可以套用，不會自動更改。</p>
              <button type="button" disabled={busy} data-testid="add-pose-fix" onClick={onPoseFix} className="chip flex h-9 items-center gap-1 rounded-full px-3"><IconPlus className="text-[12px]" />存為這個姿勢的校正</button>
              <H>建議姿勢</H>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" disabled={!r.template?.data?.pose} onClick={onApplyPose} className="chip h-9 rounded-full px-3 disabled:opacity-40">套用建議姿勢</button>
                <button type="button" disabled={busy} onClick={onSavePose} className="chip h-9 rounded-full px-3">把目前姿勢設為建議姿勢</button>
              </div>
            </>
          )}
          {defaults()}
        </div>
      )}
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
export function AppearancePanel({ tab, setTab, value, onChange, assets, onNew, onEdit, hair, selectedHair, onSelectHair, hairTool, setHairTool, onHairPatch, onSaveHair, busy, onSaveHairDefault, onAutoPlace }: { tab: LookTab; setTab: (t: LookTab) => void; value: Appearance; onChange: (v: Appearance) => void; assets: DollAsset[]; onNew: (kind: "hair" | "head", cat?: HairCat) => void; onEdit: (a: DollAsset) => void; hair: HairConfig|null; selectedHair:string|null; onSelectHair:(id:string|null)=>void; hairTool:"place"|"mesh"; setHairTool:(t:"place"|"mesh")=>void; onHairPatch:(id:string,patch:Partial<HairPart>)=>void; onSaveHair:()=>void; busy:boolean; onSaveHairDefault: (id: string) => void; onAutoPlace: (id: string) => void }) {
  const hairs = useMemo(() => [...BUILTIN_HAIRS, ...assets.filter((a) => a.kind === "hair")], [assets]);
  const heads = [...BUILTIN_HEADS, ...assets.filter((a) => a.kind === "head")];
  const resolved = resolveHairColors(value.hair_color, value.accent_color);
  const preset = HAIR_COLORS.find((c) => c.id === value.hair_color && !value.accent_color);
  const [hcat, setHcat] = useState<string>("set");
  const [extra, setExtra] = useState(false);
  const current = hair?.parts ?? [];
  const selected = current.find((p) => p.id === selectedHair);
  const changeParts = (parts: HairPart[]) => onChange({ ...value, hair_config: { parts, ref_luma: hair?.ref_luma ?? null } });
  // 所有素材內的髮件（按分類揀選）；同一張圖只列一次
  const pieces = useMemo(() => {
    const seen = new Set<string>(), out: { key: string; src: string; part: HairPart; cat: HairCat; name: string }[] = [];
    for (const h of hairs) for (const p of (h.config as HairConfig).parts) {
      if (seen.has(p.file)) continue;
      seen.add(p.file);
      const single = (h.config as HairConfig).parts.length === 1;
      out.push({ key: h.id + "/" + p.id, src: h.id, part: p, cat: hairCatOf(p), name: single && h.name && !/^(新髮型|我的髮型)$/.test(h.name) ? h.name : hairPartName(p) });
    }
    return out;
  }, [hairs]);
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
      </Row>
      <div className="scrollbar-none -mx-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2">
        {tab === "hair" && (<>
          <Row className="pb-1.5" >
            {([["set", "整套"], ...HAIR_CATS.map((c) => [c.id, c.label])] as [string, string][]).map(([c, label]) => <button key={c} type="button" data-hair-cat={c} aria-pressed={hcat === c} onClick={() => setHcat(c)} className={pill(hcat === c)}>{label}{c !== "set" && current.some((p) => hairCatOf(p) === c) ? " ●" : ""}</button>)}
          </Row>
          {hcat === "set" ? (
            <>
              <Row className="pb-1 pt-1">
                <AddCard label="新增髮型" testid="add-hair" onClick={() => onNew("hair")} />
                {hairs.map((h) => <AssetCard key={h.id} a={h} on={!value.hair_config && value.hair === h.id} onPick={() => { onChange({ ...value, hair: h.id, hair_config: null }); onSelectHair(null); }} onEdit={h.builtin ? undefined : () => onEdit(h)} />)}
                <AssetCard a={{ id: NO_HAIR_ID, name: "不戴頭髮" }} on={!current.length} onPick={() => { onChange({ ...value, hair: NO_HAIR_ID, hair_config: null }); onSelectHair(null); }} />
              </Row>
              <p className="pt-1 text-[11px] leading-snug text-mauve">整套髮型一次加入所有髮件。想逐件混搭，按上面的分類（瀏海、後髮…）揀選；同一分類會互相替換。</p>
            </>
          ) : (
            <>
              <Row className="pb-1 pt-1">
                <AddCard label={`新增${HAIR_CAT_LABEL[hcat as HairCat]}`} testid="add-hair-part" onClick={() => onNew("hair", hcat as HairCat)} />
                {pieces.filter((x) => x.cat === hcat).map((x) => {
                  const worn = current.find((p) => p.file === x.part.file);
                  return (
                    <div key={x.key} className="relative w-[74px] shrink-0">
                      <button type="button" data-hair-piece={x.key} aria-pressed={!!worn} onClick={() => { if (worn) onSelectHair(worn.id); else { const r = wearHairPart(hair, { ...x.part, src: x.src }, extra); onChange({ ...value, hair_config: r.config }); onSelectHair(r.id); } }} className="block w-full">
                        <div className={`arch arch-base relative aspect-[3/4] ${worn ? "outline-2 outline-offset-1 outline-gold-soft" : ""}`}>
                          <img src={refUrl(x.part.file)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain px-[10%] pb-[8%] pt-[16%]" />
                        </div>
                        <div className="truncate pt-1 text-center text-[10.5px]">{x.name}</div>
                      </button>
                      {worn && <span className="btn-jewel absolute -left-0.5 -top-0.5 grid h-5 w-5 place-items-center rounded-full text-[10px]">✓</span>}
                      {worn && <button type="button" aria-label={`取下 ${x.name}`} data-hair-off={x.key} onClick={() => { changeParts(current.filter((p) => p.id !== worn.id)); if (selectedHair === worn.id) onSelectHair(null); }} className="btn-dark absolute -right-0.5 -top-0.5 grid h-6 w-6 place-items-center rounded-full text-[10px]"><IconClose /></button>}
                    </div>
                  );
                })}
              </Row>
              <label className="mt-1 flex items-center gap-2 text-[11.5px]"><input type="checkbox" data-testid="hair-extra" checked={extra} onChange={(e) => setExtra(e.target.checked)} />加入額外髮件（不替換同一分類）</label>
            </>
          )}
          {current.length > 0 && (
            <>
              <H>正在使用的髮件（{current.length}）</H>
              <div className="space-y-1" data-testid="worn-hair-parts">{current.map((p, i) => (
                <div key={p.id} className={`flex items-center gap-1 rounded-xl p-1 ${selectedHair === p.id ? "bg-gold/20" : "bg-white/5"}`}>
                  <button type="button" data-worn-hair={p.id} onClick={() => onSelectHair(selectedHair === p.id ? null : p.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                    <img src={refUrl(p.file)} alt="" className="h-7 w-7 shrink-0 rounded-md bg-cream/80 object-contain" />
                    <span className="min-w-0"><span className="block truncate text-[12px]">{hairPartName(p)}</span><span className="block text-[10px] text-mauve">{HAIR_CAT_LABEL[hairCatOf(p)]}｜{p.layer === "front" ? "臉前面" : p.layer === "mid" ? "衣服前面" : "身體後面"}</span></span>
                  </button>
                  <button type="button" aria-label={p.hidden ? "顯示髮件" : "隱藏髮件"} className="chip grid h-7 w-7 place-items-center rounded-full text-[12px]" onClick={() => onHairPatch(p.id, { hidden: !p.hidden })}>{p.hidden ? <IconEyeOff /> : <IconEye />}</button>
                  <button type="button" aria-label="髮件上移" disabled={i === 0} className="chip h-7 rounded-full px-2 text-[11px] disabled:opacity-30" onClick={() => { const a = [...current]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; changeParts(a); }}>↑</button>
                  <button type="button" aria-label="髮件下移" disabled={i === current.length - 1} className="chip h-7 rounded-full px-2 text-[11px] disabled:opacity-30" onClick={() => { const a = [...current]; [a[i + 1], a[i]] = [a[i], a[i + 1]]; changeParts(a); }}>↓</button>
                  <button type="button" aria-label="移除髮件" className="chip grid h-7 w-7 place-items-center rounded-full text-[11px]" onClick={() => { changeParts(current.filter((x) => x.id !== p.id)); if (selectedHair === p.id) onSelectHair(null); }}><IconClose /></button>
                </div>
              ))}</div>
              {selected && (
                <div className="mt-2 rounded-xl bg-white/5 p-2" data-testid="hair-editor">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11.5px] text-gold-soft">編輯：{hairPartName(selected)}</span>
                    <button type="button" className={pill(hairTool === "place")} onClick={() => setHairTool("place")}>位置</button>
                    <button type="button" data-testid="hair-mesh" className={pill(hairTool === "mesh")} onClick={() => setHairTool("mesh")}>變形</button>
                    <button type="button" disabled={!selected.mesh} className="chip rounded-full px-3 py-1.5 disabled:opacity-40" onClick={() => onHairPatch(selected.id, { mesh: undefined })}>重設變形</button>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-mauve">分類</span>
                    <select aria-label="髮件分類" data-testid="hair-part-cat" value={hairCatOf(selected)} onChange={(e) => onHairPatch(selected.id, { cat: e.target.value as HairCat })} className="rounded-full bg-velvet px-2 py-1 text-[12px]">{HAIR_CATS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
                    {(["back", "mid", "front"] as const).map((l) => <button type="button" key={l} className={pill(selected.layer === l)} onClick={() => onHairPatch(selected.id, { layer: l })}>{l === "front" ? "臉前面" : l === "mid" ? "衣服前面" : "身體後面"}</button>)}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button type="button" data-testid="hair-autoplace" className="chip rounded-full px-3 py-1.5" onClick={() => onAutoPlace(selected.id)}>自動對準頭部</button>
                    {selected.src && !selected.src.startsWith("builtin:") && <button type="button" data-testid="hair-save-default" disabled={busy} className="chip rounded-full px-3 py-1.5" onClick={() => onSaveHairDefault(selected.id)}>存為這件髮件的預設位置</button>}
                  </div>
                  <p className="pt-1 text-[11px] leading-snug text-mauve">在角色上拖動髮件；右下角把手縮放，上方把手旋轉。雙指只放大畫面。</p>
                </div>
              )}
              <button type="button" data-testid="save-hair-combo" disabled={busy} onClick={onSaveHair} className="btn-jewel mt-2 w-full rounded-full py-2">保存目前組合為新髮型</button>
            </>
          )}
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
export type SkeletonMode = "clean" | "region" | "full" | "wire";
export const SKELETON_MODES: { id: SkeletonMode; label: string; hint: string }[] = [
  { id: "clean", label: "乾淨預覽", hint: "畫布上不顯示任何骨架；用下面的小人及滑桿調整，可以清楚看到穿著效果。" },
  { id: "region", label: "局部骨架", hint: "只顯示目前身體區域的控制點。" },
  { id: "full", label: "完整骨架", hint: "顯示全部控制點（進階）。" },
  { id: "wire", label: "線框", hint: "暫時淡化角色及衣服，骨架更容易看清及拖動。" },
];
export type PoseTab = "presets" | "joints" | "advanced";
/** 姿勢小圖／可點選的骨架小人：按姿勢畫出骨架。onPick＝點選關節 */
function Figure({ rig, pose, width, active, region, onPick }: { rig: Rig; pose: Pose; width: number; active?: string | null; region?: string[] | null; onPick?: (bone: string) => void }) {
  const j = useMemo(() => jointPositions(rig, pose), [rig, pose]);
  const mats = useMemo(() => solve(rig, pose), [rig, pose]);
  const body = rig.bones.filter((b) => !b.id.startsWith("hair") && !b.id.startsWith("hp_"));
  const tip = (id: string, x: number, y: number) => applyMat(mats[id], x, y);
  const ends: [string, [number, number]][] = [];
  for (const s of ["r", "l"]) {
    const h = rig.anchors["hand_" + s], a = boneMap(rig).get("ankle_" + s);
    if (h && mats["wrist_" + s]) ends.push(["wrist_" + s, tip("wrist_" + s, h[0], h[1])]);
    if (a && mats["ankle_" + s]) ends.push(["ankle_" + s, tip("ankle_" + s, a.pivot[0], a.pivot[1] + 110)]);
  }
  const head = tip("head", 600, 170);
  const sw = onPick ? 26 : 44;
  return (
    <svg viewBox="150 0 900 1800" width={width} height={width * 2} className="block" data-testid={onPick ? "mini-rig" : undefined}>
      <circle cx={head[0]} cy={head[1]} r={118} fill="none" stroke="currentColor" strokeWidth={sw} opacity={0.9} />
      {body.filter((b) => b.parent && b.parent !== "root").map((b) => <line key={b.id} x1={j[b.parent!][0]} y1={j[b.parent!][1]} x2={j[b.id][0]} y2={j[b.id][1]} stroke="currentColor" strokeWidth={sw} strokeLinecap="round" opacity={region && !region.includes(b.id) && !region.includes(b.parent!) ? 0.35 : 0.9} />)}
      {ends.map(([id, p]) => <line key={id + "e"} x1={j[id][0]} y1={j[id][1]} x2={p[0]} y2={p[1]} stroke="currentColor" strokeWidth={sw} strokeLinecap="round" opacity={region && !region.includes(id) ? 0.35 : 0.9} />)}
      {onPick && body.filter((b) => b.id !== "root" && adjustable(rig, b.id)).map((b) => (
        <g key={b.id} data-mini={b.id} onClick={() => onPick(b.id)} style={{ cursor: "pointer" }}>
          <circle cx={j[b.id][0]} cy={j[b.id][1]} r={95} fill="transparent" />
          <circle cx={j[b.id][0]} cy={j[b.id][1]} r={active === b.id ? 52 : 34} fill={active === b.id ? "#f28ba3" : "#2a1526"} stroke="#f0d9c0" strokeWidth={12} />
        </g>
      ))}
    </svg>
  );
}
export function PosePanel({ rig, pose, front, onPose, onFront, skel, setSkel, drag, setDrag, region, setRegion, joint, setJoint, control, opacity, setOpacity, compact, tab, setTab, onFrame }: {
  rig: Rig; pose: Pose; front: FrontPart[]; onPose: (p: Pose, front?: FrontPart[]) => void; onFront: (f: FrontPart[]) => void;
  skel: SkeletonMode; setSkel: (m: SkeletonMode) => void; drag: DragMode; setDrag: (d: DragMode) => void; region: Region; setRegion: (r: Region) => void;
  /** 目前用滑桿調整的關節（骨骼 id） */
  joint: string | null; setJoint: (id: string | null) => void;
  /** 正在畫布上拖動／選中的控制點（說明它實際控制甚麼） */
  control: PoseControl | null; opacity: number; setOpacity: (v: number) => void; compact?: boolean; tab: PoseTab; setTab: (t: PoseTab) => void; onFrame: () => void;
}) {
  const bones = boneMap(rig);
  const preset = POSE_PRESETS.find((p) => samePose(rig, p.pose, pose));
  const set = (key: string, v: number) => onPose(clampPose(rig, { ...pose, [key]: v }));
  const resetBones = (list: string[]) => { const next = { ...pose }; for (const b of list) { delete next[b]; delete next[b + ".x"]; delete next[b + ".y"]; } onPose(clampPose(rig, next)); };
  const toggleFront = (k: FrontPart) => onFront(front.includes(k) ? front.filter((x) => x !== k) : [...front, k]);
  const inRegion = regionBones(rig, region).filter((b) => adjustable(rig, b));
  // 顯示哪些滑桿：畫布上拖動的是 IK 控制點時，同時顯示它自動調整的兩節；否則顯示選中的關節
  const ids = control?.kind === "ik" ? control.sliders : joint && bones.has(joint) ? [joint] : [];
  const pick = (id: string) => { setRegion(regionOf(id)); setJoint(id); };
  const slider = (id: string) => {
    const b = bones.get(id);
    if (!b) return null;
    const v = pose[id] ?? 0;
    return (
      <div key={id} className="mt-2" data-joint-row={id}>
        {b.min_angle !== b.max_angle && (
          <label className="grid grid-cols-[1fr_2.9rem] items-center gap-x-2">
            <span className="col-span-2 flex items-center justify-between text-[11.5px]"><span data-testid="joint-title">{jointTitle(id)}</span></span>
            <input type="range" data-bone={id} min={b.min_angle} max={b.max_angle} step={0.5} value={v} onChange={(e) => set(id, Number(e.target.value))} className="w-full" />
            <span className="text-right tabular-nums">{v > 0 ? "+" : ""}{v}°</span>
          </label>
        )}
        {b.max_offset && (["x", "y"] as const).map((axis, i) => (
          <label key={axis} className="mt-1 grid grid-cols-[4.6rem_1fr_2.9rem] items-center gap-2 text-mauve">
            <span>{jointLabel(id)}{axis === "x" ? "左右" : "上下"}</span>
            <input type="range" data-bone={`${id}.${axis}`} min={-b.max_offset![i]} max={b.max_offset![i]} step={1} value={pose[`${id}.${axis}`] ?? 0} onChange={(e) => set(`${id}.${axis}`, Number(e.target.value))} className="w-full" />
            <span className="text-right tabular-nums">{pose[`${id}.${axis}`] ?? 0}</span>
          </label>
        ))}
      </div>
    );
  };
  if (compact) {
    return (
      <div className="text-[12.5px]" data-testid="pose-panel" data-compact="1">
        {ids.length ? ids.slice(0, 1).map(slider) : <p className="py-2 text-[11.5px] text-mauve">在角色上拖動控制點；向上拖動面板可以揀選關節及姿勢。</p>}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col text-[12.5px]" data-testid="pose-panel">
      <Row className="pb-2">
        {([["presets", "預設姿勢"], ["joints", "關節調整"], ["advanced", "進階設定"]] as [PoseTab, string][]).map(([t, label]) => <button key={t} type="button" data-posetab={t} aria-pressed={tab === t} onClick={() => setTab(t)} className={pill(tab === t)}>{label}</button>)}
        <button type="button" data-testid="pose-reset" onClick={() => onPose({}, [])} className="chip ml-auto shrink-0 rounded-full px-3 py-1.5">重設整個姿勢</button>
      </Row>
      <div className="scrollbar-none -mx-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        {tab === "presets" && (
          <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-8" data-testid="pose-presets">
            {POSE_PRESETS.map((p) => (
              <button key={p.id} type="button" data-pose={p.id} aria-pressed={preset?.id === p.id} onClick={() => onPose(p.pose, p.front ?? [])} className={`flex flex-col items-center rounded-2xl px-1 pb-1 pt-1.5 ${preset?.id === p.id ? "chip-on" : "chip"}`}>
                <Figure rig={rig} pose={p.pose} width={30} />
                <span className="mt-0.5 w-full truncate text-center text-[10px] leading-tight">{p.label}</span>
              </button>
            ))}
          </div>
        )}
        {tab === "joints" && (
          <>
            <div className="flex flex-wrap items-center gap-1.5" data-testid="skeleton-modes">
              {SKELETON_MODES.map((m) => <button key={m.id} type="button" data-skel={m.id} aria-pressed={skel === m.id} onClick={() => setSkel(m.id)} className={pill(skel === m.id)}>{m.label}</button>)}
            </div>
            {skel !== "clean" && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="drag-modes">
                <span className="text-[11px] text-mauve">拖動</span>
                {DRAG_MODES.map((m) => <button key={m.id} type="button" data-drag={m.id} aria-pressed={drag === m.id} onClick={() => setDrag(m.id)} className={pill(drag === m.id)}>{m.label}</button>)}
              </div>
            )}
            <p className="mt-1.5 text-[11px] leading-snug text-mauve" data-testid="pose-hint">{control ? control.hint : skel === "clean" ? SKELETON_MODES[0].hint : DRAG_MODES.find((m) => m.id === drag)!.hint}</p>
            <div className="mt-2 flex gap-3 rounded-2xl bg-white/5 p-2.5">
              <div className="shrink-0 text-gold-soft"><Figure rig={rig} pose={pose} width={64} active={joint} region={regionBones(rig, region)} onPick={pick} /></div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap gap-1.5" data-testid="regions">
                  {REGIONS.filter((g) => regionBones(rig, g.id).length > 0).map((g) => <button key={g.id} type="button" data-region={g.id} aria-pressed={region === g.id} onClick={() => { setRegion(g.id); const first = regionBones(rig, g.id).find((b) => adjustable(rig, b)) ?? null; setJoint(first); }} className={pill(region === g.id)}>{g.label}</button>)}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="joints">
                  {inRegion.map((b) => <button key={b} type="button" data-joint={b} aria-pressed={joint === b && control?.kind !== "ik"} onClick={() => setJoint(b)} className={pill(joint === b && control?.kind !== "ik")}>{jointLabel(b)}</button>)}
                </div>
                {ids.map(slider)}
                {!ids.length && <p className="mt-2 text-[11px] text-mauve">揀選一個關節，或點一下小人身上的圓點。</p>}
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {ids.length > 0 && <button type="button" data-testid="bone-reset" onClick={() => resetBones(ids)} className="chip rounded-full px-3 py-1.5">重設{ids.length > 1 ? "這兩個關節" : "這個關節"}</button>}
                  <button type="button" data-testid="region-reset" data-reset={region} onClick={() => resetBones(regionBones(rig, region))} className="chip rounded-full px-3 py-1.5">重設{REGIONS.find((g) => g.id === region)!.label}</button>
                  <button type="button" data-testid="pose-frame" onClick={onFrame} className="chip rounded-full px-3 py-1.5">畫面對準{REGIONS.find((g) => g.id === region)!.label}</button>
                </div>
              </div>
            </div>
          </>
        )}
        {tab === "advanced" && (
          <>
            <H>手與衣服的前後</H>
            <div className="flex flex-wrap items-center gap-1.5">
              <button type="button" aria-pressed={front.includes("hand_r")} onClick={() => toggleFront("hand_r")} className={pill(front.includes("hand_r"))}>右手在衣服前</button>
              <button type="button" aria-pressed={front.includes("hand_l")} onClick={() => toggleFront("hand_l")} className={pill(front.includes("hand_l"))}>左手在衣服前</button>
            </div>
            <H>骨架透明度</H>
            <label className="flex items-center gap-2"><span className="text-mauve">淡</span><input type="range" data-testid="skeleton-opacity" min={0.2} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="flex-1" /><span className="text-mauve">實</span></label>
            <p className="mt-1 text-[11px] leading-snug text-mauve">拖動期間骨架會完全顯示，放手後回復到這個透明度。</p>
            <H>重設</H>
            <div className="flex flex-wrap items-center gap-1.5">
              {REGIONS.filter((g) => regionBones(rig, g.id).length > 0).map((g) => <button key={g.id} type="button" data-reset={g.id} onClick={() => resetBones(regionBones(rig, g.id))} className="chip rounded-full px-2.5 py-1">{g.label}</button>)}
              <button type="button" onClick={() => onPose({}, [])} className="chip rounded-full px-2.5 py-1">整個姿勢</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
