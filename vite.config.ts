import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { execFileSync } from "node:child_process";
const sha = process.env.CF_PAGES_COMMIT_SHA || process.env.WORKERS_CI_COMMIT_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
export default defineConfig({
  define: { __AW_BUILD__: JSON.stringify({ phase: "3.5A", sha: sha.slice(0, 12), built: new Date().toISOString() }) },
  plugins: [react(), tailwindcss()],
  // Keep the jSquash browser WebP encoder unoptimized so its WASM asset URL resolves in Vite.
  optimizeDeps: { exclude: ["@jsquash/webp"] },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/mcp": "http://localhost:8787",
    },
  },
});
