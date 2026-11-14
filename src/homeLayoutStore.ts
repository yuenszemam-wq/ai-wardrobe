/**
 * 主頁布局（Phase 3.8A／3.8A.1）：伺服器保存正式設定，手機保存最新快取。
 * 開啟 App 時直接顯示本機布局（不會先顯示預設再突然切換）；伺服器版本「較新」時才更新（按 rev 及時間判斷，不只是不相同）。
 * 編輯時凍結開始編輯的版本；另一部裝置在期間保存時回報衝突，草稿保留，不會靜默覆蓋。
 */
import { useEffect, useState } from "react";
import { HomeLayout, defaultHomeLayout, isNewerLayout, normalizeHomeLayout } from "../shared/homeLayout";
import { api, ApiError, AppSettings } from "./api";
import { getSettingsCache, setSettingsCache } from "./components/ui";

const KEY = "aw:home-layout";
const listeners = new Set<(l: HomeLayout) => void>();
export function localHomeLayout(): HomeLayout | null {
  try { const v = localStorage.getItem(KEY); return v ? normalizeHomeLayout(JSON.parse(v)) : null; } catch { return null; }
}
function store(l: HomeLayout) { try { localStorage.setItem(KEY, JSON.stringify(l)); } catch { /* 私人瀏覽 */ } listeners.forEach((f) => f(l)); }
export function clearHomeLayoutCache() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

/** 目前已知的布局：本機快取與伺服器快取之中較新的一份 */
export function currentHomeLayout(): HomeLayout {
  const local = localHomeLayout(), cached = getSettingsCache()?.home_layout ? normalizeHomeLayout(getSettingsCache()!.home_layout) : null;
  return (isNewerLayout(cached, local) ? cached : local) ?? defaultHomeLayout();
}

/** 目前布局：本機快取 → 伺服器（較新時取代） */
export function useHomeLayout(): HomeLayout { return useHomeLayoutState().layout; }
/**
 * ready：已有本機或伺服器布局。全新裝置（沒有任何快取）等伺服器布局回應後才算 ready，
 * 讓主頁按真正的布局按需讀取資料，而不是先按預設布局讀取全部資料。
 */
export function useHomeLayoutState(): { layout: HomeLayout; ready: boolean } {
  const [layout, setLayout] = useState<HomeLayout>(currentHomeLayout);
  const [ready, setReady] = useState(() => !!localHomeLayout() || !!getSettingsCache());
  useEffect(() => {
    listeners.add(setLayout);
    const s = getSettingsCache();
    const apply = (st: AppSettings) => {
      setReady(true);
      const server = st.home_layout ? normalizeHomeLayout(st.home_layout) : null;
      const local = localHomeLayout();
      if (server && isNewerLayout(server, local)) store(server);
      else if (!server && local?.updated_at) { /* 伺服器已還原預設 */ clearHomeLayoutCache(); setLayout(defaultHomeLayout()); }
    };
    if (s) apply(s); else api<AppSettings>("/api/settings").then((st) => { setSettingsCache(st); apply(st); }).catch(() => setReady(true));
    return () => { listeners.delete(setLayout); };
  }, []);
  return { layout, ready };
}

/** 開始編輯時凍結的版本 */
export interface LayoutBase { rev?: number; updated_at?: string }
export const baseOf = (l: HomeLayout): LayoutBase => ({ rev: l.rev ?? 0, updated_at: l.updated_at });

export class LayoutConflict extends Error {
  constructor(public server: HomeLayout | null) { super("主頁布局已在另一部裝置更新"); }
}

/**
 * 保存布局（null＝還原預設）。base＝開始編輯時的版本；伺服器版本不同時拋出 LayoutConflict（附伺服器版本），不覆蓋。
 * force：使用者看過衝突後明確選擇覆寫（以伺服器目前版本為基準）。
 */
export async function saveHomeLayout(next: HomeLayout | null, base?: LayoutBase): Promise<HomeLayout> {
  const b = base ?? baseOf(currentHomeLayout());
  try {
    const st = await api<AppSettings>("/api/settings", { method: "PUT", json: { home_layout: next, home_layout_rev: b.rev ?? 0, ...(b.updated_at ? { home_layout_base: b.updated_at } : {}) } });
    setSettingsCache(st);
    const saved = st.home_layout ? normalizeHomeLayout(st.home_layout) : defaultHomeLayout();
    if (st.home_layout) store(saved); else { clearHomeLayoutCache(); listeners.forEach((f) => f(saved)); }
    return saved;
  } catch (e) {
    if (e instanceof ApiError && e.code === "settings_conflict") {
      const st = await api<AppSettings>("/api/settings").catch(() => null);
      if (st) setSettingsCache(st);
      throw new LayoutConflict(st?.home_layout ? normalizeHomeLayout(st.home_layout) : null);
    }
    throw e;
  }
}

/** 放棄本機草稿，改用伺服器版本 */
export function adoptServerLayout(l: HomeLayout | null) { if (l) store(l); else { clearHomeLayoutCache(); listeners.forEach((f) => f(defaultHomeLayout())); } }
