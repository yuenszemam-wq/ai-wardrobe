-- 0006：衣物價錢（只新增欄位，不修改或刪除舊資料）
--
-- price：購入價（港幣，可留空）。衣櫃總價及分析只計算已填價錢的衣物。
-- 主頁背景圖及自訂 AI 指令存放在原有的 app_settings（不需要新資料表）；背景圖檔存 R2 的 settings/ 路徑。
ALTER TABLE garments ADD COLUMN price REAL;
