# AI Wardrobe 智能電子衣櫃

私人 Lolita 衣物電子衣櫃 PWA。高清圖片存 Cloudflare R2（私人 bucket），衣物資料存 D1，ChatGPT／Claude 可經 MCP 直接匯入。

| 項目 | 內容 |
| --- | --- |
| 前端 | React 19 + TypeScript + Vite + Tailwind CSS 4，PWA（iPhone／iPad／Windows 可安裝） |
| 後端 | Cloudflare Workers（同一個 Worker 提供 API、MCP 及靜態資源） |
| 資料庫 | D1 `ai-wardrobe-db`（binding `DB`） |
| 圖片 | R2 `ai-wardrobe-images`（binding `IMAGES`，私人） |
| 部署 | Cloudflare Workers Builds 連接本 repo，push 到 `main` 自動部署 |

## 部署設定（Workers Builds）

Cloudflare Dashboard → Workers & Pages → `ai-wardrobe` → Settings → Builds → Connect：

| 欄位 | 值 |
| --- | --- |
| Git repository | `yuenszemam-wq/ai-wardrobe` |
| Production branch | `main` |
| Build command | `npm install && npm run build` |
| Deploy command | `npx wrangler deploy` |
| Root directory | （留空） |
| API token | 用自動產生的即可 |

D1／R2 綁定已寫在 `wrangler.jsonc`，部署時自動連接。**不需要設定任何 secret 或環境變數。**

### D1 migration

Workers Builds 自動產生的 token 沒有 D1 寫入權限，所以 migration 不在 build 內執行。新增 migration 時：

```bash
npx wrangler d1 migrations apply DB --remote
```

（`0001_init.sql`、`0002_upload_slots.sql`、`0003_import_staging.sql` 已於 2026-11-08 套用，並已記錄在 `d1_migrations` 表。）

## 安全設計

- **登入**：首次使用需要一次性設定碼（只存 SHA-256 雜湊於 `app_settings`，設定完成即刪除）。密碼以 PBKDF2-SHA256（100,000 次）雜湊。Session 為 HttpOnly + Secure + SameSite=Lax cookie，D1 只存雜湊。
- **CSRF**：已登入的修改請求必須帶 `X-Requested-With: ai-wardrobe`。
- **AI 權杖**：在 App「設定」產生，D1 只存雜湊；可個別停用。權限 `read,import,upload,update`，不能刪除資料或管理權杖。
- **用量控制**：每個權杖每日 3,000 次呼叫、800 MB 上傳（`wrangler.jsonc` 的 `vars` 可調整）。
- **R2 私人**：沒有公開網址；圖片只經 `/api/images/:id` 驗證後串流，`Cache-Control: private`。
- **沒有任何 Cloudflare API Token、R2 Secret、MCP Token 寫入前端或 repo。**

## 圖片規則

- 只接受 PNG、JPEG、WebP；以檔案內容（magic bytes）驗證格式及讀取尺寸、透明通道，不信任副檔名。HEIC 由瀏覽器先轉 JPEG（原尺寸）。
- 上限 25 MB；原檔原樣寫入 R2，**伺服器不會縮小或重新壓縮**。低於 300×300 的圖片會標示警告並轉為待確認。
- 縮圖（480px WebP）由瀏覽器產生，另存 `thumbnails/`，不覆蓋原圖。列表載入縮圖，詳情頁才載入高清圖。
- SHA-256 去重：同一件衣物同一類型的相同圖片不會重複儲存。
- 流程：驗證 → 寫 R2 → 寫 D1；D1 失敗即刪除 R2 物件（補償）。設定頁另有「孤兒檔案」檢查／清理。
- 禁止 Base64 JSON 上傳到 REST API（回 415）。MCP 工具容許 Base64 只作傳輸，伺服器轉為二進位存 R2，D1 永不存圖片內容。

R2 key：

```
originals/{garment_id}/{image_id}.{jpg|png|webp}
processed/{garment_id}/{image_id}.{png|webp}
thumbnails/{garment_id}/{image_id}.webp
outfits/{outfit_id}/{image_id}.{ext}
```

## API

所有 `/api/*`（除 `auth` 及 `public/upload`）需要登入 cookie 或 `Authorization: Bearer <權杖>`。

```
POST  /api/import/batches                 建立批次（client_ref 相同即續用）
GET   /api/import/batches/{id}            批次及每項狀態
POST  /api/import/batches/{id}/items      加入衣物／穿搭（client_key 冪等）
POST  /api/import/batches/{id}/finalize   完成批次
POST  /api/import/batches/{id}/upload-link 產生短效上傳連結
POST  /api/import/jobs/{id}               {action: approve|reject|retry}
POST  /api/images/upload                  multipart（file + garment_id|outfit_id|job_id + image_type）
PUT   /api/images/upload?garment_id=…&image_type=…   原始 binary
GET   /api/images/{id}                    驗證後串流圖片
GET   /api/garments  /api/garments/{id}   PATCH /api/garments/{id}
GET/POST /api/outfits  GET/PATCH/DELETE /api/outfits/{id}
```

## MCP（ChatGPT／Claude）

網址：`https://<worker 網域>/mcp/<權杖>`（在 App「設定」產生）。Streamable HTTP、無狀態 JSON 回應。

工具：`import_garment_files`、`create_upload_session`、`get_upload_session`（批量上傳，建議使用），以及 `list_garments`、`get_garment`、`create_import_batch`、`add_garments`、`upload_garment_image`、`create_upload_link`、`update_garment`、`finalize_import_batch`、`get_import_status`。

### 批量上傳（R2 先寫、D1 後寫）

每批最多 10 件。AI 先提交衣物資料，伺服器只建立「上傳槽」（`upload_slots`）並預留 `garment_id`，**不建立衣物記錄**。收到圖片後：

1. 驗證實際檔案內容：去背圖（`processed`）只收 PNG／WebP，必須有透明通道；若提供 `expected_width`／`expected_height`，尺寸必須完全相同（防止途中被縮小）。
2. SHA-256 去重：衣櫃已有同一張圖 → `duplicate`，不重複建立；同一槽重傳同一張 → 冪等回應。
3. 原檔原樣寫入 R2（R2 以 SHA-256 校驗）。
4. R2 成功後，在**同一個 D1 transaction** 建立 `garments`、`garment_images`、`import_jobs` 並把槽標為 `done`。D1 失敗即刪除 R2 物件，槽標為 `failed`，可用同一網址重試。

同一槽同時上傳會被鎖（409），每槽最多重試 8 次。

| 來源 | 做法 |
| --- | --- |
| ChatGPT 對話中的附件 | `import_garment_files`：`files` 為 `openai/fileParams`，ChatGPT 自動傳入 `{download_url, file_id, mime_type?, file_name?}`，伺服器下載原檔。 |
| ChatGPT Python／sandbox 產生的去背圖 | sandbox **不能連網**，也不能把檔案直接交給工具（OpenAI 官方說明）。改用 `create_upload_session`：ChatGPT 給使用者下載檔案及 `upload_page_url`，使用者在上傳頁一次選取全部檔案，按檔名自動配對。 |
| 可連網的程式（例如 Claude Code、curl） | 每個槽有 `put_url`：`curl -T 01_xxx.png -H 'content-type: image/png' '<put_url>'`。 |

短效網址：`/api/upload/{token}`（GET 狀態）、`PUT /api/upload/{token}/{slot_id}`（原始二進位）、`PUT …/{slot_id}/thumbnail`（上傳頁產生的縮圖）。權杖只存雜湊，預設 3 小時、最長 24 小時有效；跨網域 PUT 需 CORS preflight 而本 API 不回 CORS 標頭，惡意網頁不能代為上傳；`POST` 必須帶 `X-Requested-With`。過期後以同一 `batch_id` 再呼叫 `create_upload_session`（`items` 留空）即可為未完成項目產生新連結。


`upload_garment_image` 接受三種來源：

1. `file`（`{download_url, file_id, mime_type?, file_name?}`）——ChatGPT 對話檔案；工具已標記 `_meta["openai/fileParams"] = ["file"]`。
2. `image_url`——https 下載連結。
3. `image_base64`——備用。

無法傳送圖片內容的客戶端（例如 Claude 對話中的附件）用 `create_upload_link`：使用者開啟連結，在手機選相上傳，連結短效、只限指定衣物、不需登入。

AI 不確定的分類會留空並列入 `uncertain_fields`，衣物狀態為「待確認」；真人穿搭照以 `kind: "outfit"` 保存為待整理穿搭，不會假裝已拆成單品。

## ChatGPT 經 Cloudflare 連接器匯入（D1 暫存 → R2）

適用於不能加自訂連接器、但可以用 Cloudflare 連接器執行 D1 SQL 的 ChatGPT。

1. ChatGPT 把去背圖 Base64 寫入 `ai-wardrobe-db` 的 `import_staging`，同時提交**它自己計算的原檔 SHA-256**。每段建議 ≤ 1,000,000 字元（D1 每行上限 2 MB），大圖用 `part_no`／`part_count` 分段。
2. Worker 每分鐘（cron）處理已收齊的項目：接回分段 → 解碼 → **SHA-256 必須一致** → 沿用上傳槽流程（PNG／WebP、尺寸、透明檢查 → 先寫 R2 → 成功後才寫衣物記錄）→ 清空暫存 Base64。
3. 結果寫回 `import_staging`：`status`（done／duplicate／failed）、`error_message`、`garment_id`。失敗後可用 `INSERT OR REPLACE` 重寫同一 `client_ref`＋`client_key`＋`part_no`。

```sql
INSERT OR REPLACE INTO import_staging
  (client_ref, client_key, part_no, part_count, data, sha256, file_name, image_type, expected_width, expected_height, garment_json)
VALUES (?, ?, 1, 1, ?, ?, ?, 'processed', ?, ?, ?);

-- 一分鐘後核實
SELECT client_key, status, error_message, garment_id FROM import_staging WHERE client_ref = ? GROUP BY client_key;
```

`garment_json` 例：`{"name":"黑色十字架 JSK","category":"連身裙","subcategory":"JSK","style":"Gothic Lolita","primary_color":"黑","needs_review":true}`。App 內 `GET /api/staging` 可查看，`POST /api/staging/process` 可即時處理（只限已登入）。

## 開發

```bash
npm install
npm run build
npx wrangler dev          # 本機（需 wrangler 登入）
```

### 測試

`test/e2e.mjs` 在本機以 `node:sqlite` 模擬 D1、記憶體模擬 R2，直接執行 Worker 程式碼（68 項：批量匯入 10 張、去重、單張失敗、補償回滾、權限、上傳連結等）。需要額外安裝 `esbuild` 及 `sharp`：

```bash
npm i -D esbuild sharp && node test/e2e.mjs
```

`test/upload-slots.mjs`（54 項）測試批量上傳槽：1122×1402 透明 PNG／WebP 逐位元保留、R2 先寫 D1 後寫的次序、D1 失敗回滾及重試、縮小／JPEG／無透明的圖被拒、去重、並發鎖、進度、連結續期、ChatGPT `openai/fileParams`（模擬 download_url）。

```bash
node test/upload-slots.mjs
node test/staging.mjs      # D1 暫存匯入（22 項：分段、SHA-256、截斷、縮小、JPEG、去重）
```
