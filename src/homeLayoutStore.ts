/**
 * 主頁布局（Phase 3.8A）：伺服器保存正式設定，手機保存最新快取。
 * 開啟 App 時直接顯示本機布局（不會先顯示預設再突然切換）；伺服器版本較新時才更新。
 */
import { useEffect, useState } from "react";
import { HomeLayout, defaultHomeLayout, normalizeHomeLayout } from "../shared/homeLayout";
import { api, AppSettings } from "./api";
import { getSettingsCache, setSettingsCache } from "./components/ui";

const KEY = "aw:home-layout";
const listeners = new Set<(l: HomeLayout) => void>();
export function localHomeLayout(): HomeLayout | null {
  try { const v = localStorage.getItem(KEY); return v ? normalizeHomeLayout(JSON.parse(v)) : null; } catch { return null; }
}
function store(l: HomeLayout) { try { localStorage.setItem(KEY, JSON.stringify(l)); } catch { /* 私人瀏覽 */ } listeners.forEach((f) => f(l)); }
export function clearHomeLayoutCache() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

/** 目前布局：本機快取 → 伺服器（較新時取代） */
export function useHomeLayout(): HomeLayout {
  const [layout, setLayout] = useState<HomeLayout>(() => localHomeLayout() ?? (getSettingsCache()?.home_layout ? normalizeHomeLayout(getSettingsCache()!.home_layout) : defaultHomeLayout()));
  useEffect(() => {
    listeners.add(setLayout);
    const s = getSettingsCache();
    const apply = (st: AppSettings) => {
      const server = st.home_layout ? normalizeHomeLayout(st.home_layout) : null;
      const local = localHomeLayout();
      if (server && server.updated_at !== local?.updated_at) store(server);
      else if (!server && local?.updated_at) { /* 伺服器已還原預設 */ clearHomeLayoutCache(); setLayout(defaultHomeLayout()); }
    };
    if (s) apply(s); else api<AppSettings>("/api/settings").then((st) => { setSettingsCache(st); apply(st); }).catch(() => undefined);
    return () => { listeners.delete(setLayout); };
  }, []);
  return layout;
}

/** 保存布局（null＝還原預設）。另一部裝置已更新時回報衝突，不覆蓋較新的設定。 */
export async function saveHomeLayout(next: HomeLayout | null): Promise<HomeLayout> {
  const base = getSettingsCache()?.home_layout?.updated_at ?? localHomeLayout()?.updated_at;
  const st = await api<AppSettings>("/api/settings", { method: "PUT", json: { home_layout: next, ...(base ? { home_layout_base: base } : {}) } });
  setSettingsCache(st);
  const saved = st.home_layout ? normalizeHomeLayout(st.home_layout) : defaultHomeLayout();
  if (st.home_layout) store(saved); else { clearHomeLayoutCache(); listeners.forEach((f) => f(saved)); }
  return saved;
}
