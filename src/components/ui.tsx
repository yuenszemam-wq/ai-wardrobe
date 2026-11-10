import { TransparentImage } from "./TransparentImage";
import { ButtonHTMLAttributes, CSSProperties, ReactNode, useEffect, useState } from "react";
import { AI_STATUS_LABEL, api, AppSettings, displayName, Garment, imageUrl } from "../api";
import { navigate } from "../router";
import { IconClose, IconHeart, IconSparkle } from "./icons";

export function Link({
  to,
  className,
  children,
  onClick,
  style,
  ...aria
}: {
  to: string;
  className?: string;
  children?: ReactNode;
  onClick?: () => void;
  style?: CSSProperties;
  "aria-label"?: string;
  "aria-current"?: "page" | undefined;
}) {
  return (
    <a
      href={to}
      className={className}
      style={style}
      {...aria}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        onClick?.();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

type BtnVariant = "primary" | "ghost" | "danger" | "soft";
export function Button({
  children,
  variant = "primary",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant }) {
  const styles: Record<BtnVariant, string> = {
    primary: "btn-jewel disabled:opacity-40",
    soft: "bg-rose text-ink active:bg-rose/70 disabled:opacity-40",
    ghost: "bg-transparent text-amethyst-deep ring-1 ring-gold/60 active:bg-gold/15 disabled:opacity-40",
    danger: "bg-transparent text-wine ring-1 ring-wine/50 active:bg-wine/10 disabled:opacity-40",
  };
  return (
    <button
      {...rest}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-[15px] font-medium transition-colors ${styles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

/** 衣物卡：圓拱形窗，頂部掛小蝴蝶結；縮圖 lazy loading，沒有縮圖時才載入高清主圖 */
export function GarmentTile({ g, size = "md", selected, onSelect, showPrice, transparentOnly = false }: { transparentOnly?: boolean; g: Garment; size?: "sm" | "md" | "xs"; selected?: boolean; onSelect?: () => void; showPrice?: boolean }) {
  const src = imageUrl(transparentOnly ? g.transparent_image_id : g.thumb_image_id || g.primary_image_id);
  const ImageComponent = transparentOnly ? TransparentImage : "img";
  const badge = g.ai_status && g.ai_status !== "done" ? AI_STATUS_LABEL[g.ai_status] : g.status === "review" ? "待確認" : "";
  const inner = (
    <div className="relative">
      <div className={`arch arch-base relative aspect-[3/4] ${selected ? "outline-2 outline-offset-2 outline-gold-soft" : ""}`}>
        <div className="absolute inset-0 overflow-hidden" style={{ borderRadius: "inherit" }}>
          {src ? (
            <ImageComponent src={src} alt={displayName(g)} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-contain px-[9%] pb-[9%] pt-[20%]" />
          ) : (
            <div className="absolute inset-0 grid place-items-center pt-[14%] text-[12px] text-mauve">未有圖片</div>
          )}
        </div>
        {badge && size !== "xs" && <span className="chip-on absolute bottom-2.5 left-1/2 max-w-[86%] -translate-x-1/2 truncate rounded-full px-2 py-0.5 text-[10px]">{badge}</span>}
      </div>
      {g.is_favorite && (
        <span className="absolute right-0 top-0 text-[15px] text-[#f2a7c3] drop-shadow" aria-label="已收藏">
          <IconHeart filled />
        </span>
      )}
      {selected && <span className="btn-jewel absolute left-0 top-0 grid h-6 w-6 place-items-center rounded-full text-xs">✓</span>}
      {size !== "xs" && (
        <>
          <div className={`truncate px-0.5 pt-1.5 text-center ${size === "sm" ? "text-[11px]" : "text-[13px]"} font-medium`}>{displayName(g)}</div>
          {size === "md" && (
            <div className="truncate px-0.5 text-center text-[11px] text-mauve">
              {showPrice && g.price != null ? money(g.price) : [g.subcategory || g.category, g.style].filter(Boolean).join("｜") || "未分類"}
            </div>
          )}
        </>
      )}
    </div>
  );
  if (onSelect)
    return (
      <button type="button" onClick={onSelect} className="block w-full pt-2.5 text-left" aria-pressed={selected}>
        {inner}
      </button>
    );
  return (
    <Link to={`/g/${g.id}`} className="block pt-2.5">
      {inner}
    </Link>
  );
}

/** 港幣金額：$1,280（有小數才顯示小數） */
export function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `$${n.toLocaleString("en-HK", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** 複製文字；必須在點按事件內同步呼叫（iPhone Safari 不容許等待網絡後才寫入剪貼簿） */
export function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
  return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** 使用者設定（AI 指令、主頁背景）。模組內快取，進入頁面時預先載入，按鈕按下時可即時複製 */
let settingsCache: AppSettings | null = null;
const settingsListeners = new Set<(s: AppSettings) => void>();
export function setSettingsCache(s: AppSettings) {
  settingsCache = s;
  settingsListeners.forEach((fn) => fn(s));
}
export function useSettings(): AppSettings | null {
  const [s, setS] = useState<AppSettings | null>(settingsCache);
  useEffect(() => {
    settingsListeners.add(setS);
    if (!settingsCache) api<AppSettings>("/api/settings").then(setSettingsCache).catch(() => undefined);
    else setS(settingsCache);
    return () => {
      settingsListeners.delete(setS);
    };
  }, []);
  return s;
}

/** 「交給 AI 填寫」：複製指令（可在設定頁修改），貼到已連接電子衣櫃的 Claude／ChatGPT 對話 */
export function AiHandoffButton({ count, className = "", compact }: { count?: number; className?: string; compact?: boolean }) {
  const settings = useSettings();
  return (
    <button
      type="button"
      disabled={!settings}
      onClick={async () => {
        if (!settings) return;
        const ok = await copyText(settings.ai_command);
        toast(ok ? "已複製指令，貼到 Claude／ChatGPT 對話即可" : "未能自動複製，請到「設定 → AI 指令」長按複製", ok ? "ok" : "err");
      }}
      className={`btn-jewel inline-flex items-center justify-center gap-1.5 rounded-full font-medium disabled:opacity-50 ${compact ? "min-h-9 px-3.5 text-[13px]" : "min-h-11 px-5 text-[15px]"} ${className}`}
    >
      <IconSparkle className="text-[0.9em]" />
      交給 AI 填寫{count ? `（${count}）` : ""}
    </button>
  );
}

/** 底部彈出面板 */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" role="dialog" aria-modal aria-label={title} onClick={onClose}>
      <div className="frame sheet-surface max-h-[88dvh] w-full max-w-lg overflow-y-auto rounded-b-none p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:rounded-b-[18px]" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-serif text-lg font-bold tracking-[0.08em] text-gold-soft">{title}</h2>
          <button type="button" aria-label="關閉" onClick={onClose} className="chip grid h-8 w-8 place-items-center rounded-full text-[15px]">
            <IconClose />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Chips<T extends string>({ options, value, onChange, allLabel = "全部", labels }: { options: readonly T[]; value: T | ""; onChange: (v: T | "") => void; allLabel?: string; labels?: Record<string, string> }) {
  return (
    <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 py-1">
      {[("" as T | ""), ...options].map((o) => (
        <button
          key={o || "__all"}
          type="button"
          onClick={() => onChange(o)}
          className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] transition-colors ${value === o ? "chip-on" : "chip"}`}
        >
          {o ? labels?.[o] ?? o : allLabel}
        </button>
      ))}
    </div>
  );
}

export function PageTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 pb-3 pt-6">
      <h1 className="flex items-center gap-2 font-serif text-[24px] font-bold leading-tight tracking-[0.08em] text-gold-soft">
        {children}
      </h1>
      {action}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="paper px-6 py-10 text-center">
      <p className="font-serif text-lg">{title}</p>
      {children && <div className="mt-2 text-sm text-mauve">{children}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] text-mauve">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-wine">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-2xl bg-white px-4 py-3 text-ink ring-1 ring-gold placeholder:text-mauve/80 focus:outline-none focus:ring-2 focus:ring-amethyst";

export function Toast() {
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { text: string; tone: "ok" | "err" };
      setMsg(d);
      clearTimeout(timer);
      timer = window.setTimeout(() => setMsg(null), 3200);
    };
    window.addEventListener("aw:toast", on);
    return () => window.removeEventListener("aw:toast", on);
  }, []);
  if (!msg) return null;
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4">
      <div className={`rounded-full px-5 py-2.5 text-sm shadow-lg ${msg.tone === "err" ? "bg-[#a12c4b] text-white" : "btn-dark"}`}>{msg.text}</div>
    </div>
  );
}

export function toast(text: string, tone: "ok" | "err" = "ok") {
  window.dispatchEvent(new CustomEvent("aw:toast", { detail: { text, tone } }));
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gold/30">
      <div className="h-full rounded-full bg-amethyst transition-[width]" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </div>
  );
}

export function Spinner() {
  return <div className="py-12 text-center text-sm text-mauve">載入中…</div>;
}

/** 選擇標籤（自動換行）：單選再按一次可取消；多選可設上限 */
export function PickChips({
  options,
  value,
  onChange,
  multi = false,
  max,
  extra,
}: {
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
  multi?: boolean;
  max?: number | null;
  /** 衣物現有但已不在字典內的值，照樣顯示以免被誤刪 */
  extra?: boolean;
}) {
  const shown = extra ? [...options, ...value.filter((v) => !options.includes(v))] : options;
  const full = multi && max ? value.length >= max : false;
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((o) => {
        const on = value.includes(o);
        const legacy = !options.includes(o);
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            disabled={!on && full}
            onClick={() => {
              if (!multi) onChange(on ? [] : [o]);
              else onChange(on ? value.filter((x) => x !== o) : [...value, o]);
            }}
            className={`rounded-full px-3 py-1.5 text-[13px] transition-colors disabled:opacity-35 ${on ? "chip-on" : "chip"} ${legacy ? "italic" : ""}`}
            title={legacy ? "已不在分類字典內" : undefined}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

/** 每排張數切換（2｜3｜4｜5），記住選擇 */
export function useColumns(key: string, initial = 3): [number, (n: number) => void] {
  const [n, setN] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(key));
      return v >= 2 && v <= 5 ? v : initial;
    } catch {
      return initial;
    }
  });
  return [
    n,
    (v: number) => {
      setN(v);
      try {
        localStorage.setItem(key, String(v));
      } catch {
        /* 私密瀏覽等情況忽略 */
      }
    },
  ];
}

export function ColumnSwitch({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="chip inline-flex items-center rounded-full p-0.5" role="group" aria-label="每排張數">
      {[2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-pressed={value === n}
          onClick={() => onChange(n)}
          className={`h-7 min-w-7 rounded-full px-2 text-[13px] ${value === n ? "chip-on" : "border border-transparent text-mauve"}`}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

export const GRID_COLS: Record<number, string> = {
  2: "grid-cols-2 gap-x-4 gap-y-3",
  3: "grid-cols-3 gap-x-3 gap-y-2.5",
  4: "grid-cols-4 gap-x-2.5 gap-y-2",
  5: "grid-cols-5 gap-x-2 gap-y-1.5",
};
