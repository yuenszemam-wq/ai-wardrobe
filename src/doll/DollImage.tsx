import { useEffect, useState } from "react";
import { imageUrl } from "../api";
import { highResolutionBlob, thumbnailBlob } from "../imageCache";

/** 換裝畫布上的衣物圖：先顯示 D1 縮圖，再換成 R2 現有的高清透明圖（唯讀）。 */
export function DollImage({ imageId, alt }: { imageId: string | null; alt: string }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!imageId) return;
    let cancelled = false;
    const urls: string[] = [];
    setUrl("");
    setError("");
    const show = async (blob: Blob) => {
      const u = URL.createObjectURL(blob);
      urls.push(u);
      const img = new Image();
      img.src = u;
      await img.decode();
      if (!cancelled) setUrl(u);
    };
    void (async () => {
      let shown = false;
      try {
        await show(await thumbnailBlob(imageId));
        shown = true;
      } catch {
        /* 縮圖未準備好：直接等高清圖 */
      }
      try {
        await show(await highResolutionBlob(imageUrl(imageId)));
      } catch (e) {
        if (!cancelled && !shown) setError((e as Error).message || "圖片讀取失敗");
      }
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [imageId]);
  if (url) return <img src={url} alt={alt} draggable={false} className="pointer-events-none block h-auto w-full select-none" />;
  return (
    <div role="img" aria-label={alt} className="grid aspect-[3/4] w-full place-items-center rounded-xl bg-white/70 p-1 text-center text-[11px] text-mauve">
      {imageId ? error || "載入中…" : "未有透明圖"}
    </div>
  );
}
