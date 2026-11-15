# HANDOFF：AI Wardrobe 夜間接力開發紀錄

> 本文件由每晚 02:40（香港時間）的 Claude Code 排程任務維護。下一手請先讀完本文件再開始。
> 只記錄實際完成的動作；未部署、未測試的項目會明確標示。

## 1. 最後更新時間
2026-11-16 05:40（香港時間）— 第 1 次執行

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
- ✅ 工作室 UI `src/cutoutStudio/CutoutStudio.tsx`（Chromium 測試通過；WebKit／iPhone 實機未測試）
- ✅ 觸控手勢（雙指縮放不誤擦、滾輪、縮放後筆刷位置已在 Chromium 以合成 PointerEvent 測試；Apple Pencil 及實機未測試）
- 🔄 儲存（`studioIO.ts`：原解析度 PNG、驗證 alpha、/api/images/upload、縮圖、`POST /api/cutout-edits`；遮罩不另存 R2，由去背圖 alpha÷原圖 alpha 還原；Chromium UI 測試通過）
- 🔄 migration `0017_cutout_edits.sql`（只新增表）：**未套用到任何遠端 D1**；未套用時去背圖照常保存，只是沒有跨衣物來源記錄
- ✅ 另存為新衣物（不重複存原圖、返回同一原圖繼續；Chromium 測試通過）
- ✅ 入口：衣物詳情「編輯圖片／手動去背」、CutoutSheet「手動去背／以此結果手動修正」（上傳完成頁→?cutout=1 亦經此）
- ⬜ 入口：創作工作室素材上傳（AssetUploadSheet，CutoutStudio 已支援 blob 模式，未接上）
- ✅ Segmentation Provider Interface（`src/cutoutStudio/segmentation.ts`，只有 ManualFloodProvider）
- ✅ Preview 部署成功（commit 0c84ec6）：首頁 200、`/api/cutout-edits` 未登入 401（只做了這兩個 HTTP 檢查；**未在 Preview 登入實際操作，未做 iPhone 實機**）
- 🔄 PR #25 GitHub Actions CI（validate）執行中，結果待查

### 規格 B：AI Lab Phase 1（分支 `feature/ai-lab-workers-vision`，最後 commit `6d137cb`，未開 PR）
- ✅ 開發前檢查：沿用現有 `ai_suggestions`／`submitSuggestion`（名稱欄位）、`decide`（locked_fields、version）；app 只有單一擁有者 session（以 requireSession 作「管理員」限制）
- ✅ 官方文件查證（2026-11-16）：輸入 `messages`＋`image`（base64 data URL）＋`max_tokens`；價格 4,410 neurons/M 輸入、61,493 neurons/M 輸出、US$0.011/1,000 neurons；免費每日 10,000 neurons（UTC 00:00 重設）；首次使用需送出 `{"prompt":"agree"}`（未接受時錯誤 5016）
- ✅ migration `0018_ai_lab.sql`（只新增 ai_usage_events／daily／monthly；**未套用到任何遠端 D1**）
- ✅ `worker/aiLab/`：config、provider（Workers AI）、prompt（版本 wai-garment-v1）、validate、usage（原子預留／結算）、service、routes（/api/ai-lab/status|settings|test|recognize|events）
- ✅ wrangler.jsonc：`ai` binding，正式及 Preview 都是 `AI_LAB_ENABLED=false`
- ✅ Mock 測試 `test/ai-lab.mjs` 67 項通過（未呼叫真正 Workers AI）
- ⬜ 前端：AI Lab 設定頁、衣物詳情／待整理的「AI 自動辨認」按鈕（client 端縮圖至 1024px JPEG、透明圖合成中性灰底）
- ⬜ 批量辨認 UI（每批 ≤10、逐件、取消、重試）
- ⬜ 真實 Workers AI 連線測試、30 張 ground truth 測試（**需要 Sally 先決定是否接受 Meta 授權**）
- ⬜ PR、Preview

## 3. 正在做甚麼
- 規格 A：PR #25 等 CI 結果；Preview 已部署。
- 規格 B：後端完成並 push（`feature/ai-lab-workers-vision` @ `6d137cb`），下一步做前端。

## 4. 下一步
1. 查 PR #25 CI（validate）結果；失敗就在 `claude/ai-wardrobe-cutout-ai-lab-nh3w0e` 修正。
2. 規格 B 前端（分支 `feature/ai-lab-workers-vision`）：
   - `src/aiLab.ts`：`prepareAiImage(blob)` 用 canvas 縮至長邊 1024、透明部分合成 #808080、輸出 JPEG 0.85；`recognizeGarment(g, image, {force})` POST multipart `/api/ai-lab/recognize`（request_id 用 crypto.randomUUID）。
   - 設定頁加「AI Lab／AI 實驗室」（src/pages/Settings.tsx 的清單）：狀態、用量、開關、Kill Switch、較低上限、測試連線（提示會用額度）、最近記錄。
   - 衣物詳情（src/pages/GarmentDetail.tsx）及 AI 待整理（src/pages/AiReview.tsx）加「AI 自動辨認／重新辨認（會消耗額度）」；只在 status.active 時顯示。
   - 批量：逐件呼叫、每批 ≤ limits.max_batch。
3. 開規格 B 的 draft PR（不合併），確認 Preview 建置。
4. 規格 A 餘項：AssetUploadSheet 接上 CutoutStudio（blob 模式）。

## 5. 問題及已嘗試方法
- `gh auth status` 顯示 GH_TOKEN 無效；改用 GitHub MCP 工具及 git（經 proxy）操作，git fetch 正常。

## 6. 等待 Sally 決定
- **規格 B：是否接受 Meta Llama 3.2 授權**（需要以 Cloudflare API 對 `@cf/meta/llama-3.2-11b-vision-instruct` 送出 `{"prompt":"agree"}`；本任務不會自動執行）。未接受前不能做真實連線及 30 張測試。
- 規格 B：是否在 Preview 開啟 AI Lab（把 wrangler.jsonc `previews.vars.AI_LAB_ENABLED` 改為 "true"）及套用 migration 0018 到 Preview D1。
- 規格 B：提供 30 張授權測試圖片及人工答案（ground truth）。
- 規格 B：Cloudflare 帳戶是 Workers Free 還是 Paid 未能確認（本環境沒有帳戶計費權限）；免費額度屬整個帳戶。
- 規格 A：migration `0017_cutout_edits.sql`（只新增表）是否套用到 Preview／正式 D1（未套用時功能仍可用，只是缺跨衣物來源記錄）。
- 規格 A：PR #25 實機驗收後才合併。
- （暫無）

## 7. 分支／PR／Preview
- 分支 `claude/ai-wardrobe-cutout-ai-lab-nh3w0e`（規格 A，系統指定的開發分支名稱）
- PR #25（draft）：https://github.com/yuenszemam-wq/ai-wardrobe/pull/25
- 規格 A Preview：https://claude-ai-wardrobe-cutout-ai-lab-nh3w0e-ai-wardrobe.yuenszemam.workers.dev （使用 Preview D1／R2）
- 規格 B 分支：`feature/ai-lab-workers-vision`（未開 PR）

## 8. 測試結果
- `node test/cutout-studio.mjs`：52 項通過（Node，非瀏覽器；2000×3000 魔術棒約 120 ms、柔化約 880 ms）
- `node test/cutout-studio-ui.mjs`（Chromium，模擬 iPhone）：55 項通過
- build、typecheck 通過；回歸 cutout、e2e、doll-api、phase39a2、39a21、39a3、38c、d1-limits、phase39a2-ui、39a21-ui、39a3-ui、38-wardrobe 通過
- 未測試：WebKit（本機未安裝，CI continue-on-error）、iPhone 實機、Preview 內實際操作
- 規格 B：`node test/ai-lab.mjs` 67 項通過（Mock env.AI）；回歸 ai-intake、organize、e2e、taxonomy、d1-limits、doll-api、phase39b1、39b2、38c 通過；build、typecheck、`wrangler deploy --dry-run`（只驗證設定）通過。真實 Workers AI：未測試
