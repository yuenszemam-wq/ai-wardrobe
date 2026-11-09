import { ButtonHTMLAttributes, ReactNode, useEffect, useState } from "react";
import { AI_STATUS_LABEL, displayName, Garment, imageUrl } from "../api";
import { navigate } from "../router";

export function Link({ to, className, children, onClick }: { to: string; className?: string; children: ReactNode; onClick?: () => void }) {
  return (
    <a
      href={to}
      className={className}
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
    primary: "bg-amethyst text-white active:bg-amethyst-deep disabled:opacity-40",
    soft: "bg-rose text-ink active:bg-rose/70 disabled:opacity-40",
    ghost: "bg-transparent text-amethyst-deep ring-1 ring-amethyst/30 active:bg-rose-soft disabled:opacity-40",
    danger: "bg-transparent text-wine ring-1 ring-wine/30 active:bg-wine/10 disabled:opacity-40",
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

/** 拱窗形衣物卡：縮圖 lazy loading；沒有縮圖時才載入高清主圖 */
export function GarmentTile({ g, size = "md", selected, onSelect }: { g: Garment; size?: "sm" | "md"; selected?: boolean; onSelect?: () => void }) {
  const src = imageUrl(g.thumb_image_id || g.primary_image_id);
  const inner = (
    <>
      <div className={`arch relative aspect-[3/4] overflow-hidden ${selected ? "ring-2 ring-amethyst ring-offset-2 ring-offset-lace" : ""}`}>
        {src ? (
          <img src={src} alt={displayName(g)} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-contain p-[8%] pt-[14%]" />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-sm text-mauve">未有圖片</div>
        )}
        {g.ai_status && g.ai_status !== "done" ? (
          <span className="absolute bottom-2 left-2 rounded-full bg-ink/85 px-2 py-0.5 text-[11px] text-rose">{AI_STATUS_LABEL[g.ai_status]}</span>
        ) : (
          g.status === "review" && <span className="absolute bottom-2 left-2 rounded-full bg-ink/85 px-2 py-0.5 text-[11px] text-rose">待確認</span>
        )}
        {g.is_favorite && <span className="absolute bottom-2 right-2 text-[15px] text-amethyst" aria-label="已收藏">♥</span>}
        {selected && <span className="absolute right-2 top-[18%] grid h-6 w-6 place-items-center rounded-full bg-amethyst text-xs text-white">✓</span>}
      </div>
      <div className={`mt-1.5 truncate ${size === "sm" ? "text-[12px]" : "text-[13px]"} font-medium`}>{displayName(g)}</div>
      {size === "md" && (
        <div className="truncate text-[11px] text-mauve">{[g.subcategory || g.category, g.style].filter(Boolean).join("｜") || "未分類"}</div>
      )}
    </>
  );
  if (onSelect)
    return (
      <button type="button" onClick={onSelect} className="block w-full text-left" aria-pressed={selected}>
        {inner}
      </button>
    );
  return (
    <Link to={`/g/${g.id}`} className="block">
      {inner}
    </Link>
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
          className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] transition-colors ${
            value === o ? "bg-ink text-rose" : "bg-white text-ink ring-1 ring-ink/10"
          }`}
        >
          {o ? labels?.[o] ?? o : allLabel}
        </button>
      ))}
    </div>
  );
}

export function PageTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 pb-3 pt-5">
      <h1 className="font-serif text-[26px] font-bold leading-tight tracking-wide">{children}</h1>
      {action}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-3xl bg-rose-soft px-6 py-10 text-center">
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
  "w-full rounded-2xl bg-white px-4 py-3 text-ink ring-1 ring-ink/10 placeholder:text-mauve/70 focus:outline-none focus:ring-2 focus:ring-amethyst";

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
      <div className={`rounded-full px-5 py-2.5 text-sm shadow-lg ${msg.tone === "err" ? "bg-wine text-white" : "bg-ink text-rose"}`}>{msg.text}</div>
    </div>
  );
}

export function toast(text: string, tone: "ok" | "err" = "ok") {
  window.dispatchEvent(new CustomEvent("aw:toast", { detail: { text, tone } }));
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-rose">
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
            className={`rounded-full px-3 py-1.5 text-[13px] transition-colors disabled:opacity-35 ${
              on ? "bg-ink text-rose" : "bg-white text-ink ring-1 ring-ink/10"
            } ${legacy ? "italic" : ""}`}
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
    <div className="inline-flex items-center rounded-full bg-white p-0.5 ring-1 ring-ink/10" role="group" aria-label="每排張數">
      {[2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-pressed={value === n}
          onClick={() => onChange(n)}
          className={`h-7 min-w-7 rounded-full px-2 text-[13px] ${value === n ? "bg-ink text-rose" : "text-mauve"}`}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

export const GRID_COLS: Record<number, string> = {
  2: "grid-cols-2 gap-x-3 gap-y-5",
  3: "grid-cols-3 gap-x-2.5 gap-y-4",
  4: "grid-cols-4 gap-x-2 gap-y-3",
  5: "grid-cols-5 gap-x-1.5 gap-y-3",
};
