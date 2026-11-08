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

（`0001_init.sql` 已於 2026-11-08 套用，並已記錄在 `d1_migrations` 表。）

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

工具：`list_garments`、`get_garment`、`create_import_batch`、`add_garments`、`upload_garment_image`、`create_upload_link`、`update_garment`、`finalize_import_batch`、`get_import_status`。

`upload_garment_image` 接受三種來源：

1. `file`（`{download_url, file_id}`）——ChatGPT 對話檔案；工具已標記 `_meta["openai/fileParams"] = ["file"]`。
2. `image_url`——https 下載連結。
3. `image_base64`——備用。

無法傳送圖片內容的客戶端（例如 Claude 對話中的附件）用 `create_upload_link`：使用者開啟連結，在手機選相上傳，連結短效、只限指定衣物、不需登入。

AI 不確定的分類會留空並列入 `uncertain_fields`，衣物狀態為「待確認」；真人穿搭照以 `kind: "outfit"` 保存為待整理穿搭，不會假裝已拆成單品。

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
