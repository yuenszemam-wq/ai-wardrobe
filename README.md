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

（`0001_init.sql`、`0002_upload_slots.sql`、`0003_import_staging.sql` 已於 2026-11-08 套用；`0004_ai_workflow.sql`、`0005_taxonomy_layout.sql` 已於 2026-11-09 經 Cloudflare D1 API 套用；全部已記錄在 `d1_migrations` 表。）

## V3：分類字典 × 批量入庫 × 穿搭排版

- **分類字典**（D1 `taxonomy`）：主分類 → 子分類，以及屬性（袖長、裙長、材質…）→ 選項。固定 ID、顯示名稱可改。預設值在 `shared/taxonomy.ts`，首次讀取時寫入（`app_settings.taxonomy_seeded`），之後全部在 App「設定 → 分類管理」增加／改名／刪除／拖拉排序。
  - 改名會連帶更新已入庫衣物；刪除只移除字典項目，衣物保留原文字。
  - 屬性可設單選／多選、多選上限、只在某些主分類顯示（例如裙長只在連身裙、半身裙）。
  - 風格、主要顏色（最多 2 個）、季節沿用原欄位，多選以「、」分隔；次要顏色沿用 `secondary_colors`；其他屬性存 `garments.attributes`（JSON，鍵為屬性 ID）。
  - 0005 會映射舊值：Petticoat→內搭與裙撐／裙撐、Headbow→蝴蝶結、KC→髮箍、Cape→外套／斗篷／披肩、酒紅→紅、淺藍→藍、米白→米色、四季→春、夏、秋、冬。
  - MCP 新增 `list_taxonomy`。
- **待整理**搬到主頁（`/review` 會轉到 `/?tab=…`）。多選後「批量入庫」（`POST /api/garments/bulk-intake`）：有 AI 建議的可同時接受，其餘保留原資料入庫，並可一次指定主分類／子分類。
- **衣櫃**每排 2｜3｜4｜5 張，記在瀏覽器。
- **穿搭**：單品可拖動、雙指／角位把手縮放，圖層清單拖拉排序；位置存 `outfit_items.x/y/w/h`（畫布百分比）。

## V2：批量上傳 × AI 待整理

```
App 選相（最多 30 張，同時 3 張）→ /api/intake → R2 原檔 + D1「待整理衣物 NNN」（ai_status = pending_ai）
→ 使用者在 Claude／ChatGPT 發出一次「整理待處理衣物」指令
→ AI 讀清單及圖片 → 提交 ai_suggestions（不直接改 garments）→ Worker 驗證 → pending_review
→ App「AI 待整理」對比，接受全部／部分欄位／手動修改／保留原資料／重新處理 → 正式寫入
```

**圖片自動上傳 ≠ AI 自動分析。** App 不會自行辨認圖片（沒有使用任何付費 AI API）；分析要由使用者在 Claude／ChatGPT 對話中觸發。

### 上傳（`POST /api/intake`，multipart）

| 欄位 | 內容 |
| --- | --- |
| `file` | 原檔，原樣寫入 R2（不縮小、不重新壓縮）。HEIC／HEIF 原檔亦保留（`originals/{garment_id}/{image_id}.heic`） |
| `sha256` | 瀏覽器計算的原檔 SHA-256；與伺服器不符即 422 |
| `preview` | HEIC 的原尺寸 JPEG 預覽（`variant = 'preview'`，設為主圖） |
| `thumbnail` | 480px WebP 縮圖，只供列表 |
| `analysis` | 約 1600px 辨認圖（`image_type = 'thumbnail'`、`variant = 'analysis'`），由原圖縮小、未經 AI 改動 |
| `cutout` | 可選。瀏覽器自動去背後的透明 PNG（見下方「自動去背」）。存為 `processed`、成為主圖，縮圖改屬於它；原檔仍是 `original` |

- 一張相＝一件衣物，名稱「待整理衣物 NNN」（`display_no`，`name_is_placeholder = 1`），UUID 不會作顯示名稱。
- 冪等：衣物 `client_key = intake:{sha256}`；同一張相重傳、同時送出兩次都只會有一件。衣櫃已有同一張相 → 200 `duplicate`。
- 已去背的透明 PNG／WebP 直接存為 `processed`。

#### 自動去背（`src/cutout.ts`，瀏覽器端，不用 AI、不收費）

上傳中心在瀏覽器內判斷每張圖：

| 偵測結果 | 處理 |
| --- | --- |
| 已有真透明 | 不處理，照舊存為 `processed` |
| 假透明（棋盤格被畫進像素）、純色／近乎純色背景 | 從四邊 flood fill，只清除「連著邊緣」的背景色；清 1–2 px 灰白邊並柔化邊緣；被衣服圍住、同時含兩種棋盤色的洞也會清除。產生原尺寸透明 PNG 當 `cutout` 上傳 |
| 複雜實景背景、超過 12 MP、整張都像背景 | 不處理，原檔照存，上傳中心顯示原因（需要 AI 去背才能處理） |

- 原檔永遠原樣保存（`original`，SHA-256 不變）；去背圖是另一張 `processed`（`derived_from` 指向原檔）。
- 伺服器驗證 `cutout`：必須有透明通道、非 HEIC 時尺寸必須與原檔完全相同；任何問題只產生警告，不影響原檔。原檔已有真透明時不收 `cutout`。
- 限制：白色布料若直接貼著圖片邊緣，會和白色棋盤格連成一片而被一併清除；蕾絲孔等很小的洞（約小於 1.5 格）可能留有少量棋盤格殘影。
- 寫入後**讀回驗證**：R2 `head()` 的大小及 SHA-256 必須一致，否則回滾。主圖失敗會刪除剛建立、仍無圖片的衣物記錄。

### AI 狀態（`garments.ai_status`）

| 值 | App 顯示 |
| --- | --- |
| `pending_ai` | 待 AI 辨認 |
| `ai_processing` | AI 整理中（30 分鐘租約，逾時由 cron 退回） |
| `pending_review` | 待人工確認 |
| `done` | 已完成 |
| `failed` | 辨認失敗 |
| `needs_rework` | 需要重新處理 |
| `NULL` | 舊資料（不在 AI 流程內） |

### 防止覆寫

- App 使用者修改過的欄位記入 `locked_fields`；AI 的 `update_garment` 會略過這些欄位，「接受全部」亦不會覆寫。
- 每次修改 `version + 1`；AI 建議必須附上讀取時的 `base_version`，不符即拒絕（409）。
- `ai_suggestions.idempotency_key` 唯一：重試不會重複建立。
- 必須 `vision_checked = true`（AI 已實際查看圖片像素）才接受辨認結果；只看到 metadata 要用 `outcome = "failed"`。
- 品牌分級 `confirmed`／`likely`／`unconfirmed`：只有 `confirmed` 並附來源連結才會寫入 `brand`；證據來自 AI 生成／去背圖的會自動降為 `likely`。其餘只記入 `ai_note` 作候選。

### API

```
POST /api/intake                         批量上傳（一張相＝一件待整理衣物）
GET  /api/ai/queue?limit=10              待整理清單（含 version、locked_fields、短效簽名圖片網址）
POST /api/ai/claim                       {garment_ids} 標記 AI 整理中
POST /api/ai/suggestions                 提交建議（update 權限）
GET  /api/ai/review?ai_status=…          確認中心（含最新建議）
POST /api/ai/garments/{id}/decide        {action: accept_all|accept_fields|keep_original|mark_unconfirmed|rework, fields?, edits?, version?}（只限登入使用者）
POST /api/ai/decide-bulk                 批量接受
POST /api/ai/status                      {garment_ids, ai_status}
GET  /api/ai-image/{image_id}?exp&sig    短效簽名圖片網址（HMAC，60 分鐘，不需登入）
```

MCP 新工具：`list_pending_garments`、`get_garment_image`（回傳 MCP image content，AI 真正看到像素）、`claim_garments`、`submit_ai_suggestion`。

### ChatGPT 經 Cloudflare 連接器（只能執行 D1 SQL）

Worker 每分鐘為待整理衣物把短效簽名網址寫入 `ai_image_links`（需要使用者在部署後最少開過一次 App，Worker 才知道公開網址）。

```sql
-- 1. 讀取待整理清單及圖片網址
SELECT g.id AS garment_id, g.version, g.name, g.ai_status, g.locked_fields,
       l.purpose, l.image_id, l.url, l.width, l.height, l.mime_type, l.expires_at
FROM garments g JOIN ai_image_links l ON l.garment_id = g.id
WHERE g.ai_status IN ('pending_ai','needs_rework','failed') AND l.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
ORDER BY g.display_no, l.purpose LIMIT 60;

-- 2. 每件提交一行建議（payload 為欄位 JSON）；Worker 一分鐘內驗證
INSERT INTO ai_suggestions (garment_id, idempotency_key, base_version, source, image_id, vision_checked, payload)
VALUES (?, ?, ?, 'chatgpt', ?, 1, ?);

-- 3. 核實
SELECT id, garment_id, status, error_message FROM ai_suggestions WHERE idempotency_key IN (?, ?) ;
```

`status` 為 `valid` 即已放入「AI 待整理」；`invalid` 會在 `error_message` 說明原因（例如 `stale_version`、`vision_required`）。ChatGPT 是否能真正開啟網址並查看像素**未驗證**，須以實測為準。

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
node test/cutout.mjs [假透明圖片]   # 自動去背（11 項；需要 Node 22.18+ 及 sharp；附圖片路徑時輸出去背結果到 test/.tmp/）
node test/ai-intake.mjs    # V2 批量上傳及 AI 待整理（75 項，含 12 項自動去背圖：10 張上傳、逐位元／SHA-256、HEIC、去重、並發、簽名網址、MCP 讀圖、建議驗證、版本、鎖定欄位、品牌分級、D1 提交、確認、批量）
```

## 角色換裝工作室（Phase 3）

把衣櫃內現有的透明圖穿在可動角色（Avatar V2，唯一角色）身上。入口在「穿搭」主頁的「角色換裝」卡片，路徑 `/dressing`、`/dressing/:id`。與衣服配搭編輯器互相獨立，不讀寫 `outfits`／`outfit_items`。

- **畫布**：邏輯尺寸 1200×1800。角色、頭髮及衣物全部畫在同一張 Canvas（`src/doll/engine.ts`）；造型縮圖用同一套繪畫程式輸出。
- **骨架**：`public/doll/avatar_v2/rig.json`（v3，由 `scripts/build-avatar-v2.py` 及 `scripts/extend-avatar-rig.py` 產生）。22 節骨骼：整體重心、骨盆、腰、上胸、頸、頭、左右肩／肘／腕、左右髖／膝／踝、馬尾及側髮；部分節點可平移。姿勢＝`{ 骨骼: 角度, "骨骼.x": 平移 }`。引擎在 `shared/avatarRig.ts`（FK、兩節 IK、拖動末端瞄準）。
- **自由疊穿**：沒有互斥規則。分類只決定預設位置及預設圖層次序（`shared/doll.ts` 的 `insertIndex`），造型內的次序＝`items` 陣列次序，可在「圖層」拖動、隱藏、脫下。
- **衣物跟隨骨架（Phase 3.1）**：`shared/garmentMesh.ts`。每件衣物是連續的三角網格，頂點按骨骼權重平滑混合（Linear Blend Skinning），只會彎曲或拉伸，不會斷開。上身衣物分為「衣身」及「左右袖」三層：衣身一層伸入袖根底下，袖根（肩關節附近）仍然跟隨上胸，再向外過渡到手臂，所以袖子移開時不會露出空洞。褲／襪／鞋按左右腿分層；裙、頭飾、配件整件跟隨一節骨骼。舊的柔邊分區做法（`shared/skin.ts`）已移除。
- **自動分辨袖子**：`detectSleeves` 按衣身側線（腋下至腰最窄的幾行、袖子內側、由下面看的輪廓三種線索）劃分，袖子須與肩膊附近的布料相連並且夠大；把握不足（例如長袖垂在裙身上連成一片、只是肩帶旁的荷葉邊）就保持整件衣物，不強行拆件。
- **部件編輯**：衣物編輯的「部件」分頁可用筆刷標記右袖／左袖／衣身、改為「整件衣物（不拆袖）」、調整袖子靜止角度。人工部件圖是低解像度 PNG（R 通道＝部件編號 × 50），存在造型（`items[].parts`）或衣物預設（`data.parts`）。
- **變形後的點選及塗抹**：點選、遮罩筆刷及部件筆刷都沿實際變形後的網格逆向換算到圖片位置（`locate`），任何姿勢下操作的都是畫面上看到的那塊布料；「移到身後」的部分與前面用同一組網格變形。遮罩快取以完整內容雜湊識別。
- **其他（Phase 3.1）**：撤銷／重做（畫布左下角）、闊度及高度獨立微調（`fit.sy`，存在 `data.sy`）、姿勢校正（穿法可連同姿勢保存，擺出相近姿勢時提示套用）、匯出透明 PNG（1200×1800）。資料表沒有改動。
- **後領及遮罩**：預設把頸部重畫在衣服後領之上（只限衣服蓋住頸部的位置）；另可在角色身上塗抹遮罩：「隱藏」或「移到身後」。遮罩是低解像度 PNG，原圖不變。
- **衣物預設 vs 造型內調整**：`doll_fit_templates`（位置欄位＋`data` JSON：跟隨方式、後領、遮罩、建議姿勢、其他穿法）是衣物預設；造型內的個別調整存在 `doll_looks.state` 的 `items[].fit／opts／mask`，`null`＝跟隨預設。位置以靜止姿勢的畫布座標儲存，顯示時跟隨所附接的骨骼。
- **穿法**：一件衣物可保存多種穿法（`data.variants`），可選擇另一張透明圖（存為 `garment_part` 素材），例如外套打開。
- **角色素材**：頭部及髮型可在 App 內上傳、對位及管理（`doll_assets`／`doll_asset_files`，圖片在 R2 的 `doll/` 路徑；孤兒清理已排除）。髮型可只有一張圖，或多張部件各自設定前後圖層及獨立髮束骨骼。沒有染色遮罩的髮型會自動分辨主髮色及挑染。內置素材與上傳素材用同一種設定格式（`shared/avatarV2.ts`）。
- **舊造型**：Avatar V1 已淘汰（素材已移除）。舊造型（`state` 為 NULL）開啟時由 `doll_look_items` 讀出並換算到 V2（`convertLegacyFit`），保存後才寫入新格式；V1 的穿著模板保留在資料表，只在該衣物未有 V2 預設時換算使用。
- **資料表**：0008（`doll_fit_templates`、`doll_looks`、`doll_look_items`）、0009（髮色及姿勢欄位）、0010（`doll_looks.state`、`doll_fit_templates.data`、`doll_look_thumbs`、`doll_assets`、`doll_asset_files`；全部只新增）。0010 復原：`DROP TABLE doll_asset_files; DROP TABLE doll_assets; DROP TABLE doll_look_thumbs;`（兩個新增欄位可保留，舊程式不會讀取）。
- **API**：`GET /api/doll/templates`、`PUT｜DELETE /api/doll/templates/:garment_id`、`GET｜POST /api/doll/looks`、`GET｜PATCH｜DELETE /api/doll/looks/:id`、`GET｜PUT /api/doll/looks/:id/thumb`、`GET｜POST /api/doll/assets`、`PATCH｜DELETE /api/doll/assets/:id`、`POST /api/doll/assets/:id/files`、`GET｜PUT /api/doll/assets/:id/thumb`、`GET｜DELETE /api/doll/files/:id`。寫入只限 App 登入使用者。
- **不會做的事**：不呼叫 AI、不修改或刪除衣物圖片及現有衣物／穿搭記錄。
- **測試**：`node test/doll-logic.mjs`（純邏輯）、`node test/doll-api.mjs`（migration＋API）、`node test/doll-ui.mjs`（Chromium 模擬 iPhone 尺寸；不等於 iPhone Safari 實機驗收）。 `node test/mesh-integrity.mjs` 把純色測試衣物逐個姿勢實際畫出來，檢查有沒有斷成碎片、大面積消失或漂浮布料；`MESH_SOURCE=衣物PNG資料夾 node test/mesh-lab.mjs` 可用真實衣物圖輸出各姿勢的效果圖（衣物圖片不放進 repo）。
