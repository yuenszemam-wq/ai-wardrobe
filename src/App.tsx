import { startThumbnailMaintenance } from "./thumbnailMaintenance";
import { clearImageMemory } from "./imageCache";
import { ReactElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, AppSettings } from "./api";
import { clearHomeLayoutCache } from "./homeLayoutStore";
import { clearCachedLists } from "./wardrobeList";
import { IconCrown, IconDress, IconGear, IconHome, IconPencil, IconPlus, IconSparkle } from "./components/icons";
import { Link, Spinner, Toast, setSettingsCache } from "./components/ui";
import { match, navigate, usePath } from "./router";
import GarmentDetail from "./pages/GarmentDetail";
import Analysis from "./pages/Analysis";
import Home from "./pages/Home";
import ImportCenter from "./pages/ImportCenter";
import BatchDetail from "./pages/BatchDetail";
import Login from "./pages/Login";
import Outfits from "./pages/Outfits";
import OutfitStudio from "./pages/OutfitStudio";
import DressingRoom from "./pages/DressingRoom";
import CharacterStudio from "./pages/CharacterStudio";
import ModelEditor from "./pages/ModelEditor";
import GarmentSetup from "./pages/GarmentSetup";
import PublicUpload from "./pages/PublicUpload";
import Settings from "./pages/Settings";
import TaxonomyManager from "./pages/TaxonomyManager";
import Wardrobe from "./pages/Wardrobe";
import { setLocalAccount } from "./localWardrobe";
import { OfflineBanner } from "./components/OfflineBanner";

const AUTH_KEY = "aw:last-auth";
const OFFLINE_DAYS = 30;
function rememberAuth(username: string) { try { localStorage.setItem(AUTH_KEY, JSON.stringify({ username, at: Date.now() })); } catch { /* 私人瀏覽 */ } }
function forgetAuth() { try { localStorage.removeItem(AUTH_KEY); } catch { /* ignore */ } }
/** 可以離線唯讀使用的帳戶（最近 30 日內曾經成功登入） */
function offlineAccount(): string | null { try { const v = JSON.parse(localStorage.getItem(AUTH_KEY) || "null") as { username: string; at: number } | null; return v && Date.now() - v.at < OFFLINE_DAYS * 864e5 ? v.username : null; } catch { return null; } }

interface AuthState {
  setup_required: boolean;
  logged_in: boolean;
  username: string | null;
}

export default function App() {
  const path = usePath();
  const [offline,setOffline]=useState(!navigator.onLine);
  useEffect(()=>{const update=()=>setOffline(!navigator.onLine);window.addEventListener("online",update);window.addEventListener("offline",update);return()=>{window.removeEventListener("online",update);window.removeEventListener("offline",update);};},[]);
  const [auth, setAuth] = useState<AuthState | null>(null);

  useEffect(()=>{if(auth?.logged_in)return startThumbnailMaintenance();},[auth?.logged_in]);
  // 登入後讀取設定一次：介面主題及主頁布局若在另一部裝置更新，套用較新的版本
  useEffect(()=>{if(auth?.logged_in)api<AppSettings>("/api/settings").then(setSettingsCache).catch(()=>undefined);},[auth?.logged_in]);

  /**
   * 登入狀態（Phase 3.8B 離線安全策略）：
   * - 伺服器確認已登入：記錄帳戶及確認時間，開啟該帳戶的本機衣櫃。
   * - 伺服器回覆未登入／登入過期：鎖定本機資料（不讀取），保留以便重新登入後不用重新下載。
   * - 沒有網絡：最近 30 日內曾在這部手機成功登入的帳戶，可以離線唯讀查看已同步的資料；超過期限需要連線重新登入。
   * - 明確登出：刪除該帳戶的本機資料庫及圖片快取（見設定 → 帳戶）。
   */
  const refresh = useCallback(() => {
    api<AuthState>("/api/auth/status")
      .then(a=>{setAuth(a);if(a.logged_in&&a.username){if(navigator.onLine)rememberAuth(a.username);void setLocalAccount(a.username);}if(!a.logged_in){void setLocalAccount(null);clearImageMemory();clearCachedLists();clearHomeLayoutCache();navigator.serviceWorker?.controller?.postMessage({type:"CLEAR_PRIVATE"});}})
      .catch(() => {
        const last = offlineAccount();
        if (last && !navigator.onLine) { void setLocalAccount(last); setAuth({ setup_required: false, logged_in: true, username: last }); }
        else setAuth({ setup_required: false, logged_in: false, username: null });
      });
  }, []);

  useEffect(() => {
    refresh();
    const on = () => {void setLocalAccount(null);forgetAuth();clearImageMemory();navigator.serviceWorker?.controller?.postMessage({type:"CLEAR_PRIVATE"});setAuth((a) => (a ? { ...a, logged_in: false } : a));};
    window.addEventListener("aw:unauthorized", on);
    return () => window.removeEventListener("aw:unauthorized", on);
  }, [refresh]);

  // 短效上傳連結不需要登入
  const upload = match("/u/:token", path);
  if (upload) return <PublicUpload token={upload.token} />;

  if (!auth) return <Spinner />;
  if (!auth.logged_in) return <Login setupRequired={auth.setup_required} onDone={refresh} />;

  let page: ReactElement;
  let p: Record<string, string> | null;
  if (match("/", path)) page = <Home />;
  else if (match("/wardrobe", path)) page = <Wardrobe />;
  else if (match("/analysis", path)) page = <Analysis />;
  else if ((p = match("/g/:id", path))) page = <GarmentDetail id={p.id} />;
  else if (match("/import", path)) page = <ImportCenter />;
  else if (match("/review", path)) {
    // 「待整理」已搬到主頁
    const qs = path.split("?")[1];
    setTimeout(() => navigate(`/${qs ? `?${qs}` : "?tab=todo"}#todo`, true), 0);
    page = <Spinner />;
  } else if (match("/taxonomy", path)) page = <TaxonomyManager />;
  else if ((p = match("/import/:id", path))) page = <BatchDetail id={p.id} />;
  else if (match("/outfits", path)) page = <Outfits />;
  else if (match("/outfits/new", path)) page = <OutfitStudio />;
  else if ((p = match("/outfits/:id", path))) page = <OutfitStudio id={p.id} />;
  else if (match("/dressing", path)) page = <DressingRoom />;
  else if (match("/dressing/setup", path)) page = <GarmentSetup />;
  else if ((p = match("/dressing/setup/:gid", path))) { const q = new URLSearchParams(path.split("?")[1] ?? ""); page = <DressingRoom setup={{ gid: p.gid, piece: q.get("piece"), model: q.get("model") }} />; }
  else if (match("/dressing/assets", path)) page = <CharacterStudio />;
  else if ((p = match("/dressing/models/:id", path))) page = <ModelEditor id={p.id} />;
  else if ((p = match("/dressing/:id", path))) page = <DressingRoom id={p.id} />;
  else if (match("/settings", path)) page = <Settings username={auth.username} onLogout={refresh} />;
  else if ((p = match("/settings/:section", path))) page = <Settings username={auth.username} onLogout={refresh} section={p.section} />;
  else page = <div className="py-20 text-center text-mauve">找不到這一頁</div>;

  return (
    <div className="mx-auto min-h-screen max-w-5xl">
      <header className="safe-top lace-b sticky top-0 z-30" style={{ background: "var(--aw-header)" }}>
        <div className="flex h-10 items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 font-serif text-[18px] tracking-[0.16em] text-gold-soft">
            <IconSparkle className="text-[10px] text-gold" />
            電子衣櫃
            <IconSparkle className="text-[10px] text-gold" />
          </Link>
          {match("/", path) ? (
            <button type="button" data-testid="home-edit" onClick={() => window.dispatchEvent(new Event("aw:edit-home"))} className="btn-dark flex items-center gap-1 rounded-full px-3.5 py-1 text-[13px]">
              <IconPencil className="text-[13px]" />
              編輯
            </button>
          ) : (
            <Link to="/import" className="btn-dark flex items-center gap-1 rounded-full px-3.5 py-1 text-[13px]">
              <IconPlus className="text-[13px]" />
              上傳
            </Link>
          )}
        </div>
      </header>
      <main className="px-4 pb-32 pt-2">{offline&&<OfflineBanner />}{page}</main>
      <TabBar path={path} />
      <Toast />
    </div>
  );
}

const TABS = [
  { to: "/", label: "首頁", Icon: IconHome, test: (p: string) => p === "/" || p.startsWith("/analysis") },
  { to: "/wardrobe", label: "衣櫃", Icon: IconCrown, test: (p: string) => p.startsWith("/wardrobe") || p.startsWith("/g/") },
  { to: "/import", label: "上傳", Icon: IconPlus, test: (p: string) => p.startsWith("/import") },
  { to: "/outfits", label: "穿搭", Icon: IconDress, test: (p: string) => p.startsWith("/outfits") || p.startsWith("/dressing") },
  { to: "/settings", label: "設定", Icon: IconGear, test: (p: string) => p.startsWith("/settings") || p.startsWith("/taxonomy") },
];

/** 底部選單：選中的項目在原位亮起（不再向上跳起） */
function TabBar({ path }: { path: string }) {
  const bar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const measure = () => document.documentElement.style.setProperty("--tabbar-height", `${el.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const clean = path.split("?")[0];
  return (
    <nav ref={bar} className="app-tabbar fixed inset-x-0 bottom-0 z-30" style={{ background: "var(--aw-nav)" }} aria-label="主選單">
      <div>
        <div className="mx-auto grid max-w-5xl grid-cols-5">
          {TABS.map((t) => {
            const active = t.test(clean);
            return (
              <Link key={t.to} to={t.to} className={`flex flex-col items-center gap-1 pb-2 pt-2 text-[11px] `}>
                <span className={`grid h-9 w-9 place-items-center rounded-full text-[21px] ${active ? "btn-jewel" : t.to === "/import" ? "border border-gold/60 text-gold-soft" : "border border-transparent"}`} aria-hidden>
                  <t.Icon />
                </span>
                <span aria-current={active ? "page" : undefined}>{t.label}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
