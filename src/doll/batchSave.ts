// Phase 3.8A.1：一次保存全部衣物設定＋換裝快捷工具的作用範圍。
// 純邏輯（不含 React），方便測試。保存規則與單件「存為衣物預設」相同：
//  · 衣物預設按（衣物 id，身體模型）一筆；套裝部件存在同一筆的 data.pieces[]，每個部件以 part id 區分。
//  · 同一件衣物的多個部件必須合併成一筆寫入，否則後寫的會覆蓋先寫的。
//  · 版本使用開始編輯時的版本（不在保存前讀取最新版本強行覆蓋）。
import { Fit, Piece, SLOT_SKIN, SetLayout, SetupStatus, Slot, TemplateData, WearOpts, isSlot, itemKey, normalizeTemplateData } from "../../shared/doll";
import type { Pose } from "../../shared/avatarRig";
import type { FrontPart } from "../../shared/avatarV2";
import type { Resolved, Worn } from "./model";

export type WearMode = "fixed" | "body" | "auto";
export const wearModeOf = (o: WearOpts): WearMode => (o.follow === "auto" ? "auto" : o.bone === "world" ? "fixed" : "body");
export const MODE_LABEL: Record<WearMode, string> = { fixed: "固定原圖", body: "跟隨身體", auto: "跟隨手臂" };

// ───── 快捷工具：作用範圍 ─────
export type QuickScope = "item" | "set" | "all";
export const SCOPE_LABEL: Record<QuickScope, string> = { item: "目前衣物", set: "目前套裝", all: "全部適用衣物" };

/**
 * 「跟隨手臂」只適用於有袖的上身衣物（上衣、連身裙、外套、整套）或上身部件（套裝主體）。
 * 半裙、頭飾、頸飾、腿部配件不強制使用手臂骨架；袖套等附接前臂的部件以「跟隨身體」跟隨其附接骨骼。
 */
export function armCapable(r: Pick<Resolved, "worn" | "piece">): boolean {
  return SLOT_SKIN[r.piece ? r.piece.slot : r.worn.slot] === "upper";
}

/** 部件「跟隨身體」時使用的附接骨骼：保留目前附接 → 部件預設 → 按名稱建議；整件衣物＝null（按圖層預設） */
export function bodyBoneFor(r: Pick<Resolved, "piece" | "opts" | "template">, suggest: (p: Piece) => string): string | null {
  if (!r.piece) return null;
  if (r.opts.bone && r.opts.bone !== "world") return r.opts.bone;
  const preset = r.template?.data?.pieces?.find((q) => q.id === r.piece!.id)?.opts?.bone ?? r.piece.opts?.bone;
  if (preset && preset !== "world") return preset;
  const s = suggest(r.piece);
  return s !== "world" ? s : null;
}

/** 作用範圍內可以切換的衣物（已載入、未隱藏）；跟隨手臂只計適用衣物 */
export function scopeTargets(all: Resolved[], scope: QuickScope, sel: Resolved | null, mode?: WearMode): Resolved[] {
  const visible = all.filter((r) => r.image && !r.worn.hidden);
  let list: Resolved[];
  if (scope === "item") list = sel && visible.some((r) => r.key === sel.key) ? [sel] : [];
  else if (scope === "set") list = sel ? visible.filter((r) => r.garment.id === sel.garment.id) : [];
  else list = visible;
  return mode === "auto" ? list.filter(armCapable) : list;
}

/** 範圍內的目前模式：全部相同＝該模式；各件不同＝mixed；沒有衣物＝null */
export function scopeMode(list: Resolved[]): WearMode | "mixed" | null {
  if (!list.length) return null;
  const m = wearModeOf(list[0].opts);
  return list.every((r) => wearModeOf(r.opts) === m) ? m : "mixed";
}

/** 範圍單位（顯示「6 個部件」或「3 件衣物」） */
export const unitOf = (list: Resolved[]) => (list.length && list.every((r) => r.piece) ? "個部件" : "件");

// ───── 批量保存 ─────
export type BatchState = "modified" | "uncalibrated" | "saved" | "hidden" | "blocked";
export const STATE_LABEL: Record<BatchState, string> = { modified: "已修改", uncalibrated: "未校正", saved: "已保存", hidden: "已隱藏", blocked: "不能保存" };

export interface BatchEntry {
  key: string;
  gid: string;
  pieceId: string | null;
  /** 部件名稱或衣物名稱 */
  label: string;
  state: BatchState;
  /** 不能保存或需要注意的原因 */
  reason?: string;
  /** 已有預設，這次保存會覆寫 */
  overwrite: boolean;
  /** 預設勾選：有修改或未校正 */
  defaultOn: boolean;
  r: Resolved;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const round = (f: Fit) => ({ ...f, cx: Math.round(f.cx * 10) / 10, cy: Math.round(f.cy * 10) / 10, w: Math.round(f.w * 10) / 10, rotation: Math.round(f.rotation * 10) / 10 });

/** 這件衣物／部件目前保存的預設（沒有＝null） */
export function presetOf(r: Resolved): { fit: Fit | null; opts: WearOpts | null; mask: string | null; parts: string | null } | null {
  if (!r.template || r.template.converted) return null;
  if (r.piece) {
    const p = r.template.data?.pieces?.find((q) => q.id === r.piece!.id);
    if (!p || !p.fit) return null;
    return { fit: p.fit, opts: p.opts ?? null, mask: p.wear_mask ?? null, parts: p.parts ?? null };
  }
  const v = r.worn.variant ? r.template.data?.variants[r.worn.variant] : null;
  if (v) return { fit: v.fit ?? r.template.fit, opts: v.opts, mask: v.mask, parts: v.parts ?? null };
  return { fit: r.template.fit, opts: r.template.data?.opts ?? null, mask: r.template.data?.mask ?? null, parts: r.template.data?.parts ?? null };
}

/** 目前畫面上的設定與預設是否不同 */
export function differs(r: Resolved): boolean {
  const p = presetOf(r);
  if (!p) return true;
  return !same(p.fit && round(p.fit), round(r.fit)) || (p.opts !== null && !same(p.opts, r.opts)) || (p.mask ?? null) !== (r.mask ?? null) || (p.parts ?? null) !== (r.parts ?? null);
}

export interface EntryCtx {
  /** 目前顯示的衣物圖片 id（衣物圖片已更新時，造型快照的舊圖不能存為預設） */
  imageOf: (gid: string) => string | null | undefined;
}

export function entriesFor(resolved: Resolved[], worn: Worn[], ctx: EntryCtx): BatchEntry[] {
  const count = new Map<string, number>();
  for (const w of worn) count.set(itemKey(w), (count.get(itemKey(w)) ?? 0) + 1);
  return resolved.map((r) => {
    const pieceId = r.piece?.id ?? null;
    const label = r.piece ? r.piece.name : r.garment.name;
    const base = { key: r.key, gid: r.garment.id, pieceId, label, r };
    const preset = presetOf(r);
    const overwrite = !!preset;
    const blocked = (reason: string): BatchEntry => ({ ...base, state: "blocked", reason, overwrite, defaultOn: false });
    if ((count.get(r.key) ?? 0) > 1) return blocked("同一部件有多個不同校正實例，請先在圖層移除其中一個");
    if (r.analysis.content.approximate) return blocked("高清圖未讀取成功");
    const current = ctx.imageOf(r.garment.id) ?? null;
    if (r.worn.snapshot && r.worn.image?.startsWith("img:") && r.worn.image !== "img:" + current) return blocked("這份編輯使用舊圖片，請重新開啟最新衣物再校正");
    if (r.piece && !r.template?.data?.pieces?.some((p) => p.id === r.piece!.id)) return blocked("套裝部件已變更或刪除");
    if (r.worn.hidden) return { ...base, state: "hidden", reason: "隱藏中：請確認位置正確才保存", overwrite, defaultOn: false };
    if (!preset) return { ...base, state: "uncalibrated", overwrite, defaultOn: true };
    if (differs(r)) return { ...base, state: "modified", overwrite, defaultOn: true };
    return { ...base, state: "saved", overwrite, defaultOn: false };
  });
}

export interface BatchSummary { worn: number; modified: number; uncalibrated: number; saved: number; other: number }
export function summarize(entries: BatchEntry[]): BatchSummary {
  const n = (s: BatchState) => entries.filter((e) => e.state === s).length;
  return { worn: entries.length, modified: n("modified"), uncalibrated: n("uncalibrated"), saved: n("saved"), other: n("hidden") + n("blocked") };
}

export interface PayloadCtx {
  avatarId: string;
  pose: Pose;
  front: FrontPart[];
  /** 開始編輯時的版本 */
  versionOf: (gid: string, r: Resolved) => number;
  /** 完整保存時更新的狀態標記 */
  statusOf: (prev: SetupStatus | undefined, r: Resolved) => SetupStatus;
  /** 同時保存整套穿著配置的套裝 */
  layouts: Set<string>;
  /** 造型目前的穿著次序（由內到外），只用來取同一套裝內部件的相對次序 */
  worn: Worn[];
  now: string;
}
export interface TemplatePayload { garment_id: string; avatar_id: string; fit: Fit; slot: string; image_id: string | null; expected_version: number; data: TemplateData; /** 這一筆包含的造型項目 */ keys: string[] }

/** 把勾選的項目按衣物合併成每件衣物一筆（同一套裝的部件合併，不會互相覆蓋） */
export function buildPayloads(selected: BatchEntry[], ctx: PayloadCtx): TemplatePayload[] {
  const groups = new Map<string, BatchEntry[]>();
  for (const e of selected) if (e.state !== "blocked") groups.set(e.gid, [...(groups.get(e.gid) ?? []), e]);
  for (const gid of ctx.layouts) if (!groups.has(gid)) {
    // 只保存整套配置（部件本身沒有勾選）：仍然需要一筆記錄
    const any = selected.find((e) => e.gid === gid);
    if (any) groups.set(gid, []);
  }
  const out: TemplatePayload[] = [];
  for (const [gid, list] of groups) {
    const ref = list[0]?.r ?? selected.find((e) => e.gid === gid)?.r;
    if (!ref) continue;
    const ts = ref.template?.slot;
    const slotOfRow: Slot = isSlot(ts) ? ts : ref.worn.slot;
    const cur: TemplateData = ref.template?.data ?? normalizeTemplateData(null, slotOfRow);
    let data: TemplateData = { ...cur, converted: undefined, converted_from: undefined };
    let fit: Fit | null = ref.template?.fit ?? null;
    let slot: string = slotOfRow;
    const whole = list.find((e) => !e.pieceId);
    if (whole) {
      const r = whole.r, v = r.worn.variant;
      slot = r.worn.slot;
      if (v && data.variants[v]) data = { ...data, variants: { ...data.variants, [v]: { ...data.variants[v], fit: r.fit, opts: r.opts, mask: r.mask, parts: r.parts, pose: ctx.pose } } };
      else { data = { ...data, status: ctx.statusOf(data.status, r), opts: r.opts, mask: r.mask, parts: r.parts, pose: ctx.pose, front: ctx.front }; fit = r.fit; }
    }
    const pieceEntries = list.filter((e) => e.pieceId);
    if (pieceEntries.length) {
      const byId = new Map(pieceEntries.map((e) => [e.pieceId!, e.r]));
      data = { ...data, pieces: (data.pieces ?? []).map((q): Piece => {
        const r = byId.get(q.id);
        return r ? { ...q, fit: r.fit, opts: r.opts, wear_mask: r.mask, parts: r.parts, status: ctx.statusOf(q.status, r), pose: ctx.pose } : q;
      }) };
    }
    if (ctx.layouts.has(gid) && data.pieces?.length) {
      const ids = new Set(data.pieces.map((p) => p.id));
      const order = ctx.worn.filter((w) => w.garment_id === gid && w.piece && ids.has(w.piece)).map((w) => w.piece!);
      if (order.length) {
        const layout: SetLayout = { order, worn: order, ...(Object.keys(ctx.pose).length ? { pose: ctx.pose } : {}), avatar: ctx.avatarId, updated_at: ctx.now };
        data = { ...data, set_layout: layout };
      }
    }
    if (!fit) continue; // 沒有整件位置又沒有既有預設：不能建立部件預設（部件必須屬於已保存的套裝）
    out.push({ garment_id: gid, avatar_id: ctx.avatarId, fit, slot, image_id: ref.garment.transparent_image_id ?? null, expected_version: ctx.versionOf(gid, ref), data, keys: list.map((e) => e.key) });
  }
  return out;
}

/** 依整套配置排列要穿上的部件（由內到外）；沒有配置＝原本的部件次序 */
export function layoutOrder(pieces: Piece[], layout: SetLayout | undefined, ids?: string[]): string[] {
  const want = ids ?? (layout ? layout.worn : pieces.map((p) => p.id));
  if (!layout) return pieces.map((p) => p.id).filter((i) => want.includes(i));
  const ordered = layout.order.filter((i) => want.includes(i));
  return [...ordered, ...want.filter((i) => !ordered.includes(i))];
}
