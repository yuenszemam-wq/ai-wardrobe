// Phase 3.8A.1：共用的列表返回位置（衣服設定、角色素材、我的穿搭、換裝衣物選單…）。
// 以項目 id（data-pos-id 或 data-gid）＋與頁頂的偏移恢復，而不是只記錄 scrollY：
// 篩選、排序或清單長度改變時仍然回到同一件衣物附近。狀態保存在 sessionStorage（同一工作階段）。
import { RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";

const PREFIX = "aw:pos:";
export interface SavedPosition { anchor: string | null; index: number; offset: number; y: number }

function read(key: string): SavedPosition | null { try { const v = sessionStorage.getItem(PREFIX + key); return v ? JSON.parse(v) as SavedPosition : null; } catch { return null; } }
function write(key: string, p: SavedPosition) { try { sessionStorage.setItem(PREFIX + key, JSON.stringify(p)); } catch { /* 私密瀏覽 */ } }

/** 列表的篩選狀態（分類、子分類、搜尋、排序…）：同一工作階段返回時恢復 */
export function readListState<T extends object>(key: string, fallback: T): T {
  try { return { ...fallback, ...JSON.parse(sessionStorage.getItem(PREFIX + "state:" + key) || "{}") }; } catch { return fallback; }
}
export function writeListState(key: string, value: object) { try { sessionStorage.setItem(PREFIX + "state:" + key, JSON.stringify(value)); } catch { /* 私密瀏覽 */ } }

const nodesOf = (c: HTMLElement) => c.querySelectorAll<HTMLElement>("[data-pos-id],[data-gid]");
const idOf = (n: HTMLElement) => n.dataset.posId ?? n.dataset.gid ?? "";

/**
 * @param key 列表識別（同一頁不同模式可用不同 key，例如按身體模型）
 * @param ids 目前顯示的項目 id（null＝仍在載入）
 * @param container 列表容器
 * @param scroller 捲動容器；不提供＝整頁
 */
export function useListPosition(key: string, ids: string[] | null, container: RefObject<HTMLElement | null>, scroller?: RefObject<HTMLElement | null>, topInset = 0) {
  const restored = useRef<string | null>(null);
  const top = useCallback(() => (scroller?.current ? scroller.current.getBoundingClientRect().top : topInset), [scroller, topInset]);
  const capture = useCallback((): SavedPosition | null => {
    const c = container.current;
    if (!c || !ids) return null;
    const y = scroller?.current ? scroller.current.scrollTop : window.scrollY, t = top();
    for (const n of nodesOf(c)) {
      const r = n.getBoundingClientRect();
      if (r.bottom > t + 4) { const id = idOf(n); return { anchor: id, index: Math.max(0, ids.indexOf(id)), offset: r.top - t, y }; }
    }
    return { anchor: null, index: 0, offset: 0, y };
  }, [container, scroller, ids, top]);
  // 清單出現後恢復一次
  useLayoutEffect(() => {
    if (!ids || !ids.length || restored.current === key) return;
    restored.current = key;
    const pos = read(key);
    if (!pos) return;
    requestAnimationFrame(() => {
      const c = container.current;
      if (!c) return;
      const id = pos.anchor && ids.includes(pos.anchor) ? pos.anchor : ids[Math.min(pos.index, ids.length - 1)];
      const el = id ? c.querySelector<HTMLElement>(`[data-pos-id="${CSS.escape(id)}"],[data-gid="${CSS.escape(id)}"]`) : null;
      const sc = scroller?.current;
      if (!el) { if (sc) sc.scrollTop = pos.y; else window.scrollTo({ top: pos.y }); return; }
      const delta = el.getBoundingClientRect().top - top() - pos.offset;
      if (sc) sc.scrollTop += delta; else window.scrollTo({ top: Math.max(0, window.scrollY + delta) });
    });
  }, [key, ids, container, scroller, top]);
  // 捲動時保存。卸載時不再量度（DOM 已移除，量度結果不可靠，會蓋掉正確位置）
  useEffect(() => {
    if (!ids) return;
    let t = 0;
    const save = () => { const p = capture(); if (p) write(key, p); };
    const on = () => { clearTimeout(t); t = window.setTimeout(save, 120); };
    const target: HTMLElement | Window = scroller?.current ?? window;
    target.addEventListener("scroll", on, { passive: true });
    return () => { target.removeEventListener("scroll", on); clearTimeout(t); };
  }, [key, ids, capture, scroller]);
}

/**
 * 簡單整頁位置（內容由多個子清單組成、沒有單一 id 清單時使用，例如角色素材各分頁）：
 * 內容載入需要時間，所以在 2 秒內重試直至頁面足夠高。
 */
export function usePageScroll(key: string) {
  useEffect(() => {
    let y = 0;
    try { y = Number(sessionStorage.getItem(PREFIX + "y:" + key)) || 0; } catch { /* ignore */ }
    let tries = 0, timer = 0, user = false;
    const stopOnUser = () => { user = true; };
    window.addEventListener("touchstart", stopOnUser, { passive: true, once: true });
    window.addEventListener("wheel", stopOnUser, { passive: true, once: true });
    const attempt = () => {
      if (user || !y) return;
      if (document.documentElement.scrollHeight - window.innerHeight >= y - 2) { window.scrollTo({ top: y }); return; }
      if (++tries < 20) timer = window.setTimeout(attempt, 100);
    };
    attempt();
    let t = 0;
    const on = () => { clearTimeout(t); t = window.setTimeout(() => { try { sessionStorage.setItem(PREFIX + "y:" + key, String(Math.round(window.scrollY))); } catch { /* ignore */ } }, 150); };
    window.addEventListener("scroll", on, { passive: true });
    return () => { clearTimeout(timer); clearTimeout(t); window.removeEventListener("scroll", on); window.removeEventListener("touchstart", stopOnUser); window.removeEventListener("wheel", stopOnUser); };
  }, [key]);
}
