import { ImgHTMLAttributes, useEffect, useState } from "react";

/** Alpha-channel metadata alone does not prove that any background pixels are transparent. */
export function hasTransparentPixels(img: HTMLImageElement): boolean {
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 128 / Math.max(img.naturalWidth, img.naturalHeight));
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let transparent = false, visible = false;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] === 0) transparent = true;
    if (pixels[i] > 0) visible = true;
    if (transparent && visible) return true;
  }
  return false;
}

const checks = new Map<string, Promise<boolean>>();
function check(src: string) {
  let pending = checks.get(src);
  if (!pending) {
    pending = (async () => {
      try {
        const img = new Image();
        img.src = src;
        await img.decode();
        return hasTransparentPixels(img);
      } catch {
        checks.delete(src); // A transient network failure can be retried on the next mount.
        return false;
      }
    })();
    checks.set(src, pending);
  }
  return pending;
}

/** Never flash an opaque original while verifying a candidate. */
export function TransparentImage(props: ImgHTMLAttributes<HTMLImageElement>) {
  const [verified, setVerified] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (props.src) check(props.src).then((ok) => { if (active) setVerified(ok ? props.src! : null); });
    return () => { active = false; };
  }, [props.src]);
  return props.src && verified === props.src ? <img {...props} /> : null;
}
