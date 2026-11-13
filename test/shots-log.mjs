// CI：把截圖縮細後以 base64 印在記錄內（方便無法下載 artifact 的環境檢查畫面）。只供開發測試。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const sharp = createRequire(import.meta.url)("sharp");
const dir = process.argv[2] || "shots", pick = new RegExp(process.argv[3] || "^p34-");
for (const f of readdirSync(dir).filter((n) => pick.test(n)).sort()) {
  const b = await sharp(readFileSync(join(dir, f))).resize({ width: 320 }).jpeg({ quality: 60 }).toBuffer();
  console.log(`SHOT ${f} ${b.toString("base64")}`);
}
