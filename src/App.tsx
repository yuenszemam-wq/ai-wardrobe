import { ReactElement, useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Link, Spinner, Toast } from "./components/ui";
import { match, usePath } from "./router";
import GarmentDetail from "./pages/GarmentDetail";
import Home from "./pages/Home";
import ImportCenter from "./pages/ImportCenter";
import AiReview from "./pages/AiReview";
import BatchDetail from "./pages/BatchDetail";
import Login from "./pages/Login";
import Outfits from "./pages/Outfits";
import OutfitStudio from "./pages/OutfitStudio";
import PublicUpload from "./pages/PublicUpload";
import Settings from "./pages/Settings";
import Wardrobe from "./pages/Wardrobe";

interface AuthState {
  setup_required: boolean;
  logged_in: boolean;
  username: string | null;
}

export default function App() {
  const path = usePath();
  const [auth, setAuth] = useState<AuthState | null>(null);

  const refresh = useCallback(() => {
    api<AuthState>("/api/auth/status")
      .then(setAuth)
      .catch(() => setAuth({ setup_required: false, logged_in: false, username: null }));
  }, []);

  useEffect(() => {
    refresh();
    const on = () => setAuth((a) => (a ? { ...a, logged_in: false } : a));
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
  else if ((p = match("/g/:id", path))) page = <GarmentDetail id={p.id} />;
  else if (match("/import", path)) page = <ImportCenter />;
  else if (match("/review", path)) page = <AiReview />;
  else if ((p = match("/import/:id", path))) page = <BatchDetail id={p.id} />;
  else if (match("/outfits", path)) page = <Outfits />;
  else if (match("/outfits/new", path)) page = <OutfitStudio />;
  else if ((p = match("/outfits/:id", path))) page = <OutfitStudio id={p.id} />;
  else if (match("/settings", path)) page = <Settings username={auth.username} onLogout={refresh} />;
  else page = <div className="py-20 text-center text-mauve">找不到這一頁</div>;

  return (
    <div className="mx-auto min-h-screen max-w-5xl">
      <header className="safe-top sticky top-0 z-30 bg-ink text-rose">
        <div className="flex h-12 items-center justify-between px-4">
          <Link to="/" className="font-serif text-[17px] tracking-[0.12em] text-rose">
            ✝ 電子衣櫃
          </Link>
          <Link to="/import" className="rounded-full bg-velvet px-3 py-1 text-[13px] text-rose">
            ＋ 上傳
          </Link>
        </div>
      </header>
      <main className="px-4 pb-28">{page}</main>
      <TabBar path={path} />
      <Toast />
    </div>
  );
}

const TABS = [
  { to: "/", label: "首頁", icon: "⌂", test: (p: string) => p === "/" },
  { to: "/wardrobe", label: "衣櫃", icon: "♛", test: (p: string) => p.startsWith("/wardrobe") || p.startsWith("/g/") },
  { to: "/import", label: "上傳", icon: "✚", test: (p: string) => p.startsWith("/import") },
  { to: "/review", label: "待整理", icon: "✧", test: (p: string) => p.startsWith("/review") },
  { to: "/outfits", label: "穿搭", icon: "❦", test: (p: string) => p.startsWith("/outfits") },
  { to: "/settings", label: "設定", icon: "⚙", test: (p: string) => p.startsWith("/settings") },
];

function TabBar({ path }: { path: string }) {
  const clean = path.split("?")[0];
  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 bg-ink/95 backdrop-blur" aria-label="主選單">
      <div className="mx-auto grid max-w-5xl grid-cols-6">
        {TABS.map((t) => {
          const active = t.test(clean);
          return (
            <Link key={t.to} to={t.to} className={`flex flex-col items-center gap-0.5 pb-1 pt-2 text-[11px] ${active ? "text-rose" : "text-mauve"}`}>
              <span className={`text-[19px] leading-none ${active ? "text-rose" : ""}`} aria-hidden>
                {t.icon}
              </span>
              <span>{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
