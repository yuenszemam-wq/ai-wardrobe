import { startThumbnailMaintenance } from "./thumbnailMaintenance";
import { clearImageMemory } from "./imageCache";
import { ReactElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import { IconCrown, IconDress, IconGear, IconHome, IconPlus, IconSparkle } from "./components/icons";
import { Link, Spinner, Toast } from "./components/ui";
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
import PublicUpload from "./pages/PublicUpload";
import Settings from "./pages/Settings";
import TaxonomyManager from "./pages/TaxonomyManager";
import Wardrobe from "./pages/Wardrobe";

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

  const refresh = useCallback(() => {
    api<AuthState>("/api/auth/status")
      .then(a=>{setAuth(a);if(!a.logged_in){clearImageMemory();navigator.serviceWorker?.controller?.postMessage({type:"CLEAR_PRIVATE"});}})
      .catch(() => setAuth({ setup_required: false, logged_in: false, username: null }));
  }, []);

  useEffect(() => {
    refresh();
    const on = () => {clearImageMemory();navigator.serviceWorker?.controller?.postMessage({type:"CLEAR_PRIVATE"});setAuth((a) => (a ? { ...a, logged_in: false } : a));};
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
  else if ((p = match("/dressing/:id", path))) page = <DressingRoom id={p.id} />;
  else if (match("/settings", path)) page = <Settings username={auth.username} onLogout={refresh} />;
  else page = <div className="py-20 text-center text-mauve">找不到這一頁</div>;

  return (
    <div className="mx-auto min-h-screen max-w-5xl">
      <header className="safe-top lace-b sticky top-0 z-30 bg-ink">
        <div className="flex h-10 items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 font-serif text-[18px] tracking-[0.16em] text-gold-soft">
            <IconSparkle className="text-[10px] text-gold" />
            電子衣櫃
            <IconSparkle className="text-[10px] text-gold" />
          </Link>
          <Link to="/import" className="btn-dark flex items-center gap-1 rounded-full px-3.5 py-1 text-[13px]">
            <IconPlus className="text-[13px]" />
            上傳
          </Link>
        </div>
      </header>
      <main className="px-4 pb-32 pt-2">{offline&&<p role="status" className="mb-2 rounded bg-ink p-2 text-xs text-gold-soft">離線瀏覽：顯示已快取的資料和縮圖，連線後才能儲存或載入高清圖。</p>}{page}</main>
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
    <nav ref={bar} className="app-tabbar fixed inset-x-0 bottom-0 z-30 bg-ink" aria-label="主選單">
      <div>
        <div className="mx-auto grid max-w-5xl grid-cols-5">
          {TABS.map((t) => {
            const active = t.test(clean);
            return (
              <Link key={t.to} to={t.to} className={`flex flex-col items-center gap-1 pb-2 pt-2 text-[11px] ${active ? "text-gold-soft" : "text-mauve"}`}>
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
