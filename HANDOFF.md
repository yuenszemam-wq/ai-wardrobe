# HANDOFF：AI Wardrobe 夜間接力開發紀錄

> 本文件由每晚 02:40（香港時間）的 Claude Code 排程任務維護。下一手請先讀完本文件再開始。
> 只記錄實際完成的動作；未部署、未測試的項目會明確標示。

## 1. 最後更新時間
2026-11-16 06:30（香港時間）— 第 1 次執行

## 2. 整體進度

### 第 2 步：main 合併狀態檢查
- ✅ 已完成（2026-11-16）。結論：**main 不需要修正，沒有改動 main 的程式碼，也沒有另打備份 tag**。
  - 6 條分支的 commit 全部在 main（`git log origin/main..branch` 及 `git cherry` 皆為空）。
  - 6 條分支是線性堆疊（3.9A.2.1 → 3.9A.3 → 3.8C → 3.9B.1 → 3.9B.2 → 3.7）。合併 commit `5a1fd06` 的檔案樹與堆疊頂端 `feature/phase3.7-skinning`（42163cb）**完全相同**（`git diff` 為空），即沒有衝突時保留錯版本或遺失改動。
  - 其後 main 另有 2 個修正 commit：`5cb942e`（typecheck）、`3413d8e`（D1 100 綁定參數上限）。
  - 在 main（c0dc55c）實際執行：`npm run build` ✅、`npm run typecheck` ✅、CI 列出的 22 個非 UI 測試＋`test/cutout.mjs` 全部 ✅、UI 測試 phase39a2-ui／39a21-ui／39a3-ui／38c-ui／39b1-ui／39b2-ui（Chromium）✅。其餘 UI 測試未執行。專案沒有 lint 指令。
  - remote 已有一條 `backup-before-remerge` 分支（指向 05542be，非本任務建立），未改動。

### 規格 A：Cutout Studio 手動去背
- ✅ 開發前檢查：現有 `src/cutout.ts`（自動 flood fill 去背，純函數）、`src/cutoutFlow.ts`＋`src/components/CutoutSheet.tsx`（只有自動去背→確認保存）、`src/studio/MaskEditor.tsx`（創作工作室圖層遮罩，筆畫以 0–1 座標保存，與衣物圖片無關）。沒有完整手動去背工作室 → 新建 `src/cutoutStudio/`，重用 `autoCutout`。`garment_images.derived_from` 只能指向同一件衣物的圖片（`worker/images.ts` storeImage 驗證）。
- ✅ 非破壞性遮罩引擎 `src/cutoutStudio/maskEngine.ts`（純函數，Node 測試 52 項通過）
- ✅ 擦除／還原筆刷（引擎）
- ✅ 魔術棒（引擎）
- ✅ 自由套索／多邊形套索／矩形選取（引擎：polygonSelection／rectSelection）
- ✅ 邊緣修正（引擎：feather／morph／smooth／defringe white／color）
- ✅ Undo／Redo（引擎：MaskHistory，RLE 壓縮區塊）
- 🔄 工作室 UI `src/cutoutStudio/CutoutStudio.tsx`：已寫好並 build／typecheck 通過，**瀏覽器測試未完成**
- 🔄 觸控手勢（已實作：雙指縮放移動、滾輪、Pencil 時手指只移動、pointercancel；未測試）
- 🔄 儲存（`studioIO.ts`：原解析度 PNG、驗證 alpha、/api/images/upload、縮圖、`POST /api/cutout-edits`；遮罩不另存 R2，由去背圖 alpha÷原圖 alpha 還原；未做 UI 測試）
- 🔄 migration `0017_cutout_edits.sql`（只新增表）：**未套用到任何遠端 D1**；未套用時去背圖照常保存，只是沒有跨衣物來源記錄
- 🔄 另存為新衣物（已實作：只上傳新去背圖，cutout_edits 參照原圖；保存後返回同一原圖繼續；未測試）
- ✅ 入口：衣物詳情「編輯圖片／手動去背」、CutoutSheet「手動去背／以此結果手動修正」（上傳完成頁→?cutout=1 亦經此）
- ⬜ 入口：創作工作室素材上傳（AssetUploadSheet，CutoutStudio 已支援 blob 模式，未接上）
- ✅ Segmentation Provider Interface（`src/cutoutStudio/segmentation.ts`，只有 ManualFloodProvider）
- ⬜ 測試／Preview

### 規格 B：AI Lab Phase 1
- ⬜ 尚未開始

## 3. 正在做甚麼
- 規格 A：分支 `claude/ai-wardrobe-cutout-ai-lab-nh3w0e`，最後 commit `0f9e34d`（工作室 UI＋入口）。正在寫 Playwright 測試 `test/cutout-studio-ui.mjs`。

## 4. 下一步
1. 寫並執行 `test/cutout-studio-ui.mjs`（Chromium＋WebKit）：開啟工作室、擦除、Undo／Redo、魔術棒、套索、儲存→確認上傳 PNG 有透明像素、原圖 sha 不變、另存新衣物。加入 CI workflow。
2. 接上 AssetUploadSheet 的手動去背（blob 模式）。
3. 開 PR（不合併），等 Workers Builds Preview URL。
4. 然後開始規格 B（獨立分支 `feature/ai-lab-workers-vision`，從 main 開）。

## 5. 問題及已嘗試方法
- `gh auth status` 顯示 GH_TOKEN 無效；改用 GitHub MCP 工具及 git（經 proxy）操作，git fetch 正常。

## 6. 等待 Sally 決定
- （暫無）

## 7. 分支／PR／Preview
- 分支 `claude/ai-wardrobe-cutout-ai-lab-nh3w0e`（規格 A，系統指定的開發分支名稱）

## 8. 測試結果
- `node test/cutout-studio.mjs`：52 項通過（Node，非瀏覽器；2000×3000 魔術棒約 120 ms、柔化約 880 ms）
- UI：未測試（尚未寫）
