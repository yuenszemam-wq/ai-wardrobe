import { useEffect, useState } from "react";
import { thumbnailBlob } from "../imageCache";
import { canonicalDollBlob } from "./content";

/** 換裝畫布上的衣物圖：使用與定位一致的高清圖；降級時保持縮圖座標，不偷偷換圖。 */
export function DollImage({ imageId, alt, canonical = true }: { imageId: string | null; alt: string; canonical?: boolean }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!imageId) return;
    let cancelled = false;
    const urls: string[] = [];
    setUrl("");
    setError("");
    const show = async (blob: Blob) => {
      if (cancelled) return;
      const u = URL.createObjectURL(blob);
      urls.push(u);
      const img = new Image();
      img.src = u;
      await img.decode();
      if (!cancelled) setUrl(u);
    };
    void (async () => {
      try {
        await show(canonical ? await canonicalDollBlob(imageId) : await thumbnailBlob(imageId));
      } catch (e) {
        if (!cancelled) setError((e as Error).message || "圖片讀取失敗");
      }
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [imageId, canonical]);
  if (url) return <img src={url} alt={alt} draggable={false} className="pointer-events-none block h-auto w-full select-none" />;
  return (
    <div role="img" aria-label={alt} className="grid aspect-[3/4] w-full place-items-center rounded-xl bg-white/70 p-1 text-center text-[11px] text-mauve">
      {imageId ? error || "載入中…" : "未有透明圖"}
    </div>
  );
}
