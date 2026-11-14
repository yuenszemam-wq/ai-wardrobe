/**
 * 衣櫃清單讀取及返回位置（Phase 3.8A）。
 * - 一次讀取符合條件的完整清單（每頁 200 件，按 id 去重），畫面再分批顯示；顯示真正的總數。
 * - 同一個瀏覽工作階段內按查詢條件保留清單：由衣物詳情返回時立即顯示，不會重新初始化或清空，之後在背景更新。
 * - 返回位置：保存「最接近頁頂的衣物 id＋偏移＋已顯示數量」，不只 scrollY，衣物因排序移動時仍回到原本附近。
 * Phase 3.8B 會把清單改為 IndexedDB 本機資料庫，此模組的介面保持不變。
 */
import { api, Garment } from "./api";
import { dropLocalGarment, filterLocal, localAccount, localGarments, localQueryable, patchLocalGarment, syncWardrobe, whenLocalReady } from "./localWardrobe";

export interface ListState { items: Garment[]; at: number }
const lists = new Map<string, ListState>();
const flights = new Map<string, Promise<Garment[]>>();

/**
 * 讀取完整清單。Phase 3.8B：已登入且條件可在本機完成時，使用本機衣櫃（IndexedDB）立即回傳，
 * 背景增量同步（最多每 30 秒一次）；同步後發出 aw:wardrobe-synced，頁面再按本機資料重新篩選。
 * 本機未有資料（第一次使用）時先完成一次同步；離線且未有本機資料才失敗。
 * 其他條件（封存、自訂屬性）仍由伺服器分頁讀取，按 id 去重。
 */
export function loadFullList(query: URLSearchParams, signal?: AbortSignal, opts: { fresh?: boolean } = {}): Promise<Garment[]> {
  const key = query.toString();
  if (localAccount() && localQueryable(query)) {
    return (async () => {
      await whenLocalReady();
      if (!localGarments()) await syncWardrobe();
      else if (opts.fresh) await syncWardrobe().catch(() => undefined);
      else void syncWardrobe({ throttleMs: 30000 }).catch(() => undefined);
      const out = filterLocal(localGarments() ?? [], query);
      lists.set(key, { items: out, at: Date.now() });
      if (lists.size > 12) lists.delete(lists.keys().next().value!);
      return out;
    })();
  }
  const running = flights.get(key);
  if (running) return running;
  const p = (async () => {
    const out: Garment[] = [], seen = new Set<string>();
    let offset: number | null = 0;
    for (let page = 0; offset !== null && page < 50; page++) {
      const q = new URLSearchParams(query); q.set("limit", "200"); q.set("offset", String(offset));
      const r = await api<{ garments: Garment[]; next_offset: number | null }>(`/api/garments?${q}`, { signal });
      for (const g of r.garments) if (!seen.has(g.id)) { seen.add(g.id); out.push(g); }
      offset = r.next_offset;
    }
    lists.set(key, { items: out, at: Date.now() });
    if (lists.size > 12) lists.delete(lists.keys().next().value!);
    return out;
  })();
  flights.set(key, p); p.finally(() => flights.delete(key)).catch(() => {});
  return p;
}
export const cachedList = (query: URLSearchParams) => lists.get(query.toString()) ?? null;
/** 單件衣物已在其他頁面修改：更新所有已保存清單中的這一件（不重新讀取整個衣櫃） */
export function patchCachedGarment(g: Partial<Garment> & { id: string }) {
  for (const st of lists.values()) { const i = st.items.findIndex((x) => x.id === g.id); if (i >= 0) st.items[i] = { ...st.items[i], ...g }; }
  void patchLocalGarment(g);
}
export function dropCachedGarment(id: string) { for (const st of lists.values()) st.items = st.items.filter((x) => x.id !== id); void dropLocalGarment(id); }
export function clearCachedLists() { lists.clear(); }
if (typeof window !== "undefined") window.addEventListener("aw:unauthorized", clearCachedLists);

export interface ListPosition { anchor: string | null; index: number; offset: number; shown: number; y: number }
const POS_KEY = "aw:list-pos:";
export function savePosition(list: string, pos: ListPosition) { try { sessionStorage.setItem(POS_KEY + list, JSON.stringify(pos)); } catch { /* ignore */ } }
export function readPosition(list: string): ListPosition | null { try { const v = sessionStorage.getItem(POS_KEY + list); return v ? (JSON.parse(v) as ListPosition) : null; } catch { return null; } }

/** 目前畫面：最接近頁頂（工具列下方）的項目及其偏移 */
export function capturePosition(container: HTMLElement | null, items: { id: string }[], shown: number, topInset: number): ListPosition {
  const y = window.scrollY;
  if (!container) return { anchor: null, index: 0, offset: 0, shown, y };
  const nodes = container.querySelectorAll<HTMLElement>("[data-gid]");
  for (const n of nodes) {
    const r = n.getBoundingClientRect();
    if (r.bottom > topInset + 4) {
      const id = n.dataset.gid!;
      return { anchor: id, index: Math.max(0, items.findIndex((x) => x.id === id)), offset: r.top - topInset, shown, y };
    }
  }
  return { anchor: null, index: 0, offset: 0, shown, y };
}
/** 恢復位置：先找原本的衣物；它已移走（篩選或排序改變）就用原本的序號附近的衣物 */
export function restorePosition(container: HTMLElement | null, items: { id: string }[], pos: ListPosition, topInset: number): boolean {
  if (!container) return false;
  let id = pos.anchor && items.some((x) => x.id === pos.anchor) ? pos.anchor : items[Math.min(pos.index, items.length - 1)]?.id;
  if (!id) return false;
  const el = container.querySelector<HTMLElement>(`[data-gid="${CSS.escape(id)}"]`);
  if (!el) { window.scrollTo({ top: pos.y }); return false; }
  const top = el.getBoundingClientRect().top + window.scrollY - topInset - pos.offset;
  window.scrollTo({ top: Math.max(0, top) });
  return true;
}
