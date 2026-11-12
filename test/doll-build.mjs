// 測試用打包工具（只供開發環境）。
// 若環境沒有安裝 @jsquash（圖片編碼 WASM，換裝功能不會用到），以空替身代替，讓 Worker／前端仍可打包測試。
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TMP = join(ROOT, "test/.tmp");
mkdirSync(TMP, { recursive: true });

let stubbed = false;
export const usedCodecStub = () => stubbed;
const codecStub = {
  name: "optional-jsquash",
  setup(b) {
    b.onResolve({ filter: /^@jsquash\// }, (args) => {
      try {
        require.resolve(args.path.replace(/\?url$/, ""));
        if (!args.path.endsWith("?url")) return null; // 已安裝：照常打包
      } catch {
        stubbed = true;
      }
      return { path: args.path, namespace: "jsquash-stub" };
    });
    b.onLoad({ filter: /.*/, namespace: "jsquash-stub" }, () => ({
      contents: "const no=()=>{throw new Error('codec_unavailable_in_test')};export default no;export const init=async()=>{};export const defaultOptions={};",
      loader: "js",
    }));
  },
};

export async function buildWorker(name = "doll-worker") {
  const outfile = join(TMP, `${name}.mjs`);
  await build({ target: "es2022", loader: { ".wasm": "binary" }, entryPoints: [join(ROOT, "worker/index.ts")], bundle: true, format: "esm", platform: "neutral", outfile, logLevel: "error", plugins: [codecStub] });
  return (await import(outfile + "?t=" + Date.now())).default;
}

/** 把 TypeScript 模組打包成可直接 import 的 ESM（純邏輯測試用） */
export async function buildModule(entry, name) {
  const outfile = join(TMP, `${name}.mjs`);
  await build({ target: "es2022", entryPoints: [join(ROOT, entry)], bundle: true, format: "esm", platform: "neutral", outfile, logLevel: "error", plugins: [codecStub] });
  return import(outfile + "?t=" + Date.now());
}

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|html)$/.test(f)) out.push(p);
  }
  return out;
}

/** 前端：esbuild 打包 + Tailwind 編譯（不需要 vite）。回傳 { js, css, html } */
export async function buildApp() {
  const jsFile = join(TMP, "doll-app.js");
  await build({
    target: "es2022", entryPoints: [join(ROOT, "src/main.tsx")], bundle: true, format: "esm", platform: "browser", outfile: jsFile, logLevel: "error",
    jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "empty" }, plugins: [codecStub],
  });
  const { compile } = require("tailwindcss");
  const twDir = dirname(require.resolve("tailwindcss/package.json"));
  const compiler = await compile(readFileSync(join(ROOT, "src/styles.css"), "utf8"), {
    base: join(ROOT, "src"),
    loadStylesheet: async (id, base) => {
      const path = id === "tailwindcss" ? join(twDir, "index.css") : id.startsWith("tailwindcss/") ? join(twDir, id.slice(12)) : join(base, id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  const candidates = new Set();
  for (const f of walk(join(ROOT, "src"))) for (const m of readFileSync(f, "utf8").matchAll(/[^\s"'`{}<>=;,()]+/g)) candidates.add(m[0]);
  const css = compiler.build([...candidates]);
  writeFileSync(join(TMP, "doll-app.css"), css);
  const html = `<!doctype html><html lang="zh-Hant-HK"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>html{background:#1c0e1a}body{background:#2a1526;margin:0}</style><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`;
  return { js: readFileSync(jsFile), css, html };
}
