// 換裝頁的資料模型：衣物預設（template）、造型內的個別調整、舊造型轉換，以及相關 API。
import { HairPart, hairCatOf } from "../../shared/avatarV2";
import { BUILTIN_HAIRS, BUILTIN_HAIR_ID, BUILTIN_HEADS, BUILTIN_HEAD_ID, DollAsset, FrontPart, HairConfig, HeadConfig, NO_HAIR_ID, RIG_V2, normalizeColorValue, normalizeHairConfig, normalizeHeadConfig } from "../../shared/avatarV2";
import { Pose, normalizePose } from "../../shared/avatarRig";
import { Content, Fit, Piece, itemKey, pieceFit, LEGACY_AVATAR, LookItem, LookState, Slot, TemplateData, WearOpts, convertLegacyFit, defaultFit, defaultOpts, isSlot, normalizeFit, slotFor } from "../../shared/doll";
import { api } from "../api";
import { Analysis } from "./content";
import { SceneItem } from "./engine";

export interface GarmentLite { id: string; name: string; display_no?: number | null; category: string | null; subcategory: string | null; transparent_image_id?: string | null; thumb_image_id?: string | null }
export interface Template { garment_id: string; avatar_id: string; image_id: string | null; fit: Fit; slot: string | null; data: TemplateData | null; version: number; updated_at?: string }
/** 已穿上的衣物。v1fit＝舊角色上的個別位置，待讀到圖片後換算（只存在於前端） */
export interface Worn extends LookItem { v1fit?: Fit | null }
export interface Appearance { head: string; hair: string; hair_config?: HairConfig | null; hair_color: string; accent_color: string | null; tip_color: string | null }
export const DEFAULT_APPEARANCE: Appearance = { head: BUILTIN_HEAD_ID, hair: BUILTIN_HAIR_ID, hair_color: "brown_pink", accent_color: null, tip_color: null };

export interface LookDetail { id: string; name: string; is_favorite: boolean; thumb_at: string | null; state: LookState | null; legacy: LegacyLook | null; garments: GarmentLite[] }
interface LegacyLook { avatar_id: string; hair_color: string | null; accent_color: string | null; pose: unknown; items: { garment_id: string; slot: string; override: Fit | null }[] }

export interface Templates { v2: Map<string, Template>; v1: Map<string, Template> }
export async function fetchTemplates(): Promise<Templates> {
  const r = await api<{ templates: Template[] }>("/api/doll/templates");
  const out: Templates = { v2: new Map(), v1: new Map() };
  for (const t of r.templates) (t.avatar_id === LEGACY_AVATAR ? out.v1 : out.v2).set(t.garment_id, t);
  return out;
}

export function userAsset(a: { id: string; kind: string; name: string; category: string | null; config: unknown; thumb: string | null; garment_id?: string | null }): DollAsset | null {
  if (a.kind === "hair") { const c = normalizeHairConfig(a.config); return c && c.parts.length ? { id: a.id, kind: "hair", name: a.name, category: a.category, config: c, thumb: a.thumb } : null; }
  if (a.kind === "head") { const c = normalizeHeadConfig(a.config); return c ? { id: a.id, kind: "head", name: a.name, category: a.category, config: c, thumb: a.thumb } : null; }
  return null;
}
export const BUILTIN_THUMB: Record<string, string> = { [BUILTIN_HAIR_ID]: "/doll/avatar_v2/thumbs/hair_twin_tails_long.png", [BUILTIN_HEAD_ID]: "/doll/avatar_v2/thumbs/head_v2.png" };
export function hairOf(assets: DollAsset[], id: string, config?: HairConfig | null): HairConfig | null {
  if(config) return config.parts.length ? config : null;
  if (id === NO_HAIR_ID) return null;
  const a = assets.find((x) => x.id === id && x.kind === "hair") ?? BUILTIN_HAIRS.find((x) => x.id === id) ?? BUILTIN_HAIRS[0];
  return a.config as HairConfig;
}
/** 加入髮件，不移除其他髮件；相同來源可以重複加入，使用唯一 id。 */
export function addHairParts(config: HairConfig | null, parts: HairConfig["parts"]): HairConfig {
  const existing = config?.parts ?? [];
  const used = new Set(existing.map(p=>p.id));
  const added=parts.slice(0,Math.max(0,16-existing.length)).map(p=>{let id=p.id; for(let i=1;used.has(id);i++) id=p.id.slice(0,20)+"_"+i;used.add(id);return {...p,id};});
  return {parts:[...existing,...added],ref_luma:config?.ref_luma??null};
}
/**
 * 像換裝遊戲一樣穿上一件髮件：預設替換同一分類的髮件（例如新瀏海取代舊瀏海），其他髮件不變。
 * 已經穿著同一張圖時不會重複加入（回傳 already）。extra＝加入額外髮件（不替換）。
 */
export function wearHairPart(config: HairConfig | null, part: HairPart, extra = false): { config: HairConfig; id: string; already: boolean } {
  const cur = config?.parts ?? [];
  const same = cur.find((p) => p.file === part.file && !extra);
  if (same) return { config: config!, id: same.id, already: true };
  const cat = hairCatOf(part);
  const kept = extra ? cur : cur.filter((p) => hairCatOf(p) !== cat);
  const next = addHairParts({ parts: kept, ref_luma: config?.ref_luma ?? null }, [{ ...part, cat }]);
  return { config: next, id: next.parts[next.parts.length - 1].id, already: false };
}
export function headOf(assets: DollAsset[], id: string): HeadConfig {
  const a = assets.find((x) => x.id === id && x.kind === "head") ?? BUILTIN_HEADS[0];
  return a.config as HeadConfig;
}

export interface Resolved {
  /** 造型內的識別（衣物 id，套裝部件為「衣物 id#部件 id」） */
  key: string;
  worn: Worn;
  garment: GarmentLite;
  /** 穿著的是套裝內的一個部件 */
  piece: Piece | null;
  image: string | null;
  /** 未作個別調整時的位置（衣物預設或自動估算） */
  base: Fit;
  fit: Fit;
  opts: WearOpts;
  mask: string | null;
  /** 部件圖：null＝自動分辨 */
  parts: string | null;
  analysis: Analysis;
  from: "default" | "template" | "converted" | "override";
  template: Template | null;
}
const validTemplate = (t: Template | undefined, g: GarmentLite) => (t && t.image_id === (g.transparent_image_id ?? null) ? t : null);
export const imageOf = (w: Worn, g: GarmentLite, tpl: Template | null) => (w.variant && tpl?.data?.variants[w.variant]?.image) || (g.transparent_image_id ? "img:" + g.transparent_image_id : null);

/** 一件已穿衣物最終怎樣顯示：造型個別調整 → 穿法 → 衣物預設 → 舊角色換算 → 自動估算 */
/** 穿著中的部件設定：造型快照優先，否則用套裝目前的拆件設定 */
export function pieceOf(w: Worn, tpl: Template | null): Piece | null {
  if (!w.piece) return null;
  return w.piece_def ?? tpl?.data?.pieces?.find((p) => p.id === w.piece) ?? null;
}
/**
 * 未設定跟隨方式的部件：按名稱建議附接的骨骼（之後可以在「骨架」修改）。
 * 名稱的左右＝角色自己的左右（右袖套在畫面左邊，附接角色的右前臂）。
 */
export function pieceBone(p: Pick<Piece, "name" | "slot">): string {
  const n = p.name;
  if (/袖套|手套|手腕|手環|腕/.test(n)) return /左/.test(n) ? "elbow_l" : /右/.test(n) ? "elbow_r" : "world";
  if (/頸|領|choker|項鍊/i.test(n)) return "neck";
  if (p.slot === "headwear" || /頭飾|髮飾|帽|髮箍|kc|髮夾/i.test(n)) return "head";
  if (/鞋|襪/.test(n)) return /左/.test(n) ? "ankle_l" : /右/.test(n) ? "ankle_r" : "world";
  return "world";
}
export const templateFor = (tpls: Templates, g: GarmentLite) => validTemplate(tpls.v2.get(g.id), g);
export function resolve(w: Worn, g: GarmentLite, tpls: Templates, analyses: Map<string, Analysis>, pieceRefs?: Map<string, string>): Resolved | null {
  const tpl = validTemplate(tpls.v2.get(g.id), g);
  if (w.piece) {
    const piece = pieceOf(w, tpl);
    const image = piece ? pieceRefs?.get(itemKey(w)) ?? null : null;
    const analysis = image ? analyses.get(image) : undefined;
    if (!piece || !image || !analysis) return null;
    // 預設位置：部件自己的預設；沒有的話按套裝放在角色身上的位置換算（拆出來的部件留在原本的位置）
    const full = g.transparent_image_id ? analyses.get("img:" + g.transparent_image_id) : undefined;
    const setFit = tpl?.fit ?? (full ? defaultFit(tpl && isSlot(tpl.slot) ? tpl.slot : slotFor(g.category, g.subcategory), full.content, g.category, g.subcategory, g.name) : null);
    const base = piece.fit ?? (setFit && full ? pieceFit(setFit, full.content.ar, piece.box) : defaultFit(piece.slot, analysis.content, null, null, piece.name));
    const opts = w.opts ?? piece.opts ?? { ...defaultOpts(piece.slot), follow: "none" as const, bone: pieceBone(piece) };
    // 穿著遮罩：造型快照（null＝確實沒有）→ 個別調整 → 部件預設的穿著遮罩
    const mask = w.snapshot ? w.mask ?? null : w.mask ?? piece.wear_mask ?? null;
    return { key: itemKey(w), worn: w, garment: g, piece, image, base, fit: w.fit ?? base, opts, mask, parts: w.parts ?? null, analysis, from: w.fit || w.opts || w.mask || w.parts ? "override" : piece.fit ? "template" : "default", template: tpl };
  }
  const variant = w.variant ? tpl?.data?.variants[w.variant] ?? null : null;
  const image = imageOf(w, g, tpl);
  const analysis = image ? analyses.get(image) : undefined;
  if (!analysis) return null;
  const content: Content = analysis.content;
  const auto = () => defaultFit(w.slot, content, g.category, g.subcategory, g.name);
  const v1 = validTemplate(tpls.v1.get(g.id), g);
  let base: Fit, from: Resolved["from"];
  if (variant) { base = variant.fit ?? (variant.image ? auto() : tpl!.fit); from = "template"; }
  else if (tpl) { base = tpl.fit; from = "template"; }
  else if (v1) { base = convertLegacyFit(v1.fit, content); from = "converted"; }
  else { base = auto(); from = "default"; }
  const fit = w.fit ?? (w.v1fit ? convertLegacyFit(w.v1fit, content) : base);
  const opts = w.opts ?? variant?.opts ?? tpl?.data?.opts ?? defaultOpts(w.slot);
  const mask = w.snapshot ? w.mask : w.mask ?? variant?.mask ?? tpl?.data?.mask ?? null;
  const parts = w.snapshot ? w.parts??null : w.parts ?? (variant ? variant.parts : tpl?.data?.parts) ?? null;
  return { key: itemKey(w), worn: w, garment: g, piece: null, image, base, fit, opts, mask, parts, analysis, from: w.fit || w.v1fit || (w.opts && (from !== "default" || JSON.stringify(w.opts) !== JSON.stringify({...defaultOpts(w.slot),follow:"none",bone:"world"}))) || w.mask || w.parts ? "override" : from, template: tpl };
}
export const sceneItem = (r: Resolved): SceneItem => ({ key: r.key, image: r.image!, slot: r.worn.slot, fit: r.fit, content: r.analysis.content, grid: r.analysis.grid, opts: r.opts, mask: r.mask, parts: r.parts === "auto" ? null : r.parts, hidden: r.worn.hidden });

export function wornFor(g: GarmentLite, tpls: Templates): Worn {
  const t = validTemplate(tpls.v2.get(g.id), g) ?? validTemplate(tpls.v1.get(g.id), g);
  const slot = isSlot(t?.slot) ? t.slot : slotFor(g.category, g.subcategory);
  return { garment_id: g.id, slot, hidden: false, variant: null, fit: null, opts: t?.data ? null : { ...defaultOpts(slot), follow: "none", bone: "world" }, mask: null };
}

/** 舊造型（Phase 3 之前保存）→ 新格式。V1 的個別位置待圖片讀取後換算。 */
export function fromLegacy(l: LegacyLook): { worn: Worn[]; appearance: Appearance; pose: Pose; converted: boolean } {
  const v1 = l.avatar_id === LEGACY_AVATAR;
  const worn: Worn[] = l.items.map((it) => {
    const slot: Slot = isSlot(it.slot) ? it.slot : "accessory";
    const fit = it.override ? normalizeFit(it.override) : null;
    return { garment_id: it.garment_id, slot, hidden: false, variant: null, fit: v1 ? null : fit, v1fit: v1 ? fit : null, opts: null, mask: null };
  });
  return {
    worn, converted: v1,
    appearance: { ...DEFAULT_APPEARANCE, hair_color: normalizeColorValue(l.hair_color) ?? "brown_pink", accent_color: l.accent_color === "original" ? "original" : normalizeColorValue(l.accent_color) },
    pose: v1 ? {} : normalizePose(RIG_V2, l.pose) ?? {},
  };
}
export async function fetchLook(id: string) {
  const l = await api<LookDetail>(`/api/doll/looks/${id}`);
  const legacy = l.legacy;
  if (l.state) return { look: l, worn: l.state.items as Worn[], appearance: { head: l.state.head ?? BUILTIN_HEAD_ID, hair: l.state.hair ?? BUILTIN_HAIR_ID, hair_config:l.state.hair_config ?? null, hair_color: l.state.hair_color, accent_color: l.state.accent_color, tip_color: l.state.tip_color }, pose: l.state.pose, front: l.state.front as FrontPart[], converted: false, old: false };
  const c = fromLegacy(legacy ?? { avatar_id: "avatar_v2", hair_color: null, accent_color: null, pose: {}, items: [] });
  return { look: l, ...c, front: [] as FrontPart[], old: true };
}
