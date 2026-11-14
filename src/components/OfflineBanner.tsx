// Phase 3.8B：離線狀態列。清楚顯示目前離線、最後同步時間、本機衣物數量、圖片下載情況及哪些功能需要網絡。
import { useEffect, useState } from "react";
import { SyncStatus, localStatus, onLocalStatus } from "../localWardrobe";
import { imageCacheUsage } from "../imageCache";

export const timeAgo = (iso: string | null) => {
  if (!iso) return "未同步";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? "剛剛" : m < 60 ? `${m} 分鐘前` : m < 1440 ? `${Math.round(m / 60)} 小時前` : `${Math.round(m / 1440)} 日前`;
};
export function useLocalStatus(): SyncStatus { const [s, set] = useState(localStatus); useEffect(() => onLocalStatus(set), []); return s; }

export function OfflineBanner() {
  const s = useLocalStatus();
  const [open, setOpen] = useState(false);
  const [imgs, setImgs] = useState<{ thumbs: number; hd: number } | null>(null);
  useEffect(() => { if (open) void imageCacheUsage().then((u) => setImgs({ thumbs: u.thumbs.count, hd: u.hd.count })); }, [open]);
  return (
    <div role="status" data-testid="offline-banner" data-count={s.count} className="mb-2 rounded-2xl bg-head px-3 py-2 text-[12px] text-gold-soft">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center justify-between gap-2 text-left">
        <span>目前離線｜本機 {s.count} 件衣物｜最後同步 {timeAgo(s.lastSync)}</span><span className="text-mauve">{open ? "收起" : "詳情"}</span>
      </button>
      {s.count === 0 && <p className="mt-1 text-cream">這部手機仍未下載衣櫃資料：第一次使用需要先連線同步。</p>}
      {open && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11.5px] text-cream" data-testid="offline-details">
          <li>可以查看已同步的衣物、主頁、主題及已下載的圖片{imgs ? `（縮圖 ${imgs.thumbs} 張、高清 ${imgs.hd} 張）` : ""}。</li>
          <li>需要網絡：上傳、修改及保存衣物、保存造型、AI 整理、未下載的高清圖片。</li>
          <li>重新連線後會自動在背景同步，只下載有改動的資料。</li>
        </ul>
      )}
    </div>
  );
}
