# 薪資相容維護版本 2.2.2

來源基底是公開部署 repository 的 `6d819f03fefe33d3daa5905c5510d7c23afeb604`。本版本為經修改與驗證的相容維護 artifact；舊版 binary 不會辨識維護環境變數，不能代替此版本。

## 啟動與保護範圍

正式啟動必須設定 `NODE_ENV=production` 與精確的 `PAYROLL_WRITES_PAUSED=true`。缺值、false、拼錯或大小寫變體均拒絕正式啟動；直接匯入 writer 或啟動排程也須通過同一檢查。保留公開基底的登入、查詢、列印與依賴版本，沒有新增、刪除或反向 migration。

維護開關下，HTTP 及直接 repository 入口皆禁止新增、編輯、刪除、CSV 匯入薪資、原子批次月結、月結 run 狀態寫入、員工永久清除及薪資保留期清除。月結與 retention 排程不啟動。JSON 備份建立、刪除、還原、還原演練及自動備份全部停用；備份清單、metadata 與唯讀檢查仍可用。舊 JSON 檔案沒有新更正 journal 的完整性保證，不能作為更正後的復原 authority。

這是薪資暫停寫入模式。一般出勤、假日、設定及員工資料修改仍沿用原公開版；進行全資料庫復原前必須停止所有應用、掃碼、背景工作、外部 SQL writer 與既有請求。環境變數不能中止已通過檢查的請求，也不能阻擋舊 instance 或外部 SQL。

## 進入維護或回退

1. 記錄目前平台部署 SHA、schema 狀態、最後更正 revision、未處理調整及月結發送狀態；對照預計 artifact 的來源 SHA 與測試結果。操作正式環境須先完成使用者授權。
2. 停止所有舊 instance 與排程，等待 HTTP、登入、掃碼、月結、PDF/郵件及資料庫交易排空。停掉獨立 worker 和外部 writer。
3. 由 operator 建立完整 PostgreSQL snapshot，涵蓋全部表、journal、sequences、session epoch 與月結 run。加密保存 snapshot 與相關 runtime 檔案，記錄時間、來源版本、row counts 和 SHA256。先在乾淨隔離 DB 實際還原並比對個別金額、journal/revision、sequence 與月結狀態；應用 JSON 備份不能替代此步驟。
4. 保留 additive schema 與 journal；部署已驗證的 2.2.2 相容 artifact，維護開關固定 true。確認版本、登入及舊薪資查詢可用、所有薪資/備份寫入回傳 503、排程不寫資料，再開放唯讀薪資查詢。不要 drop journal/欄位，也不要使用未修改的 2.2.1 binary。
5. 修正版重新上線前，核對備份後的新更正、revision 與待處理金額。只更換 app artifact 不回復資料；資料 restore-to-point 是另一項操作，須先列出逐筆變化與淨差額並明確授權。核對月結 run、PDF 與已發送郵件，避免重發。

## 完整資料庫復原的登入處理

本 artifact 不提供 restore 操作。外部完整復原若帶回舊 session/sentinel，也會帶回當時登入權限；排空全部 instance 後必須另行失效所有舊登入。可以旋轉 `SESSION_SECRET`，或由 operator 在一次交易內刪除管理員 session 並設定新的 UUID epoch。另須同步旋轉所有 instance 的 `SALARY_PRINT_TOKEN_SECRET`：既有列印 token 只包含 IDs 與期限，登入 epoch 不會撤銷它們；不得讓還原前 token 讀取還原後同 ID 的資料。

既有 `public.user_sessions` JSON 中保留 SID `__payroll_restore_epoch__`，其 `sess.payrollRestoreEpoch` 存放新 UUID，expire 設為遠期且不包含 adminAuth。這是登入安全 sentinel，不是薪資備份 authority，不需要新增 schema。新登入記錄當前 epoch；舊登入、慢 GET 回存的舊 SID、在還原前開始的慢登入或提升權限，都會在 epoch 不符時被拒絕。缺少 sentinel 時 epoch 為 0；sentinel 格式錯誤或讀取失敗則拒絕授權處理。

先用隔離 DB 驗證 session 失效與新登入，再恢復流量。只刪除 session 而不旋轉 secret/epoch，無法防止尚未排空的慢請求回存舊 SID。

## 測試限制

本地正常模式可在非 production 且未設維護開關時執行公開基底測試；此模式不能作為正式維護部署。測試只使用 loopback 全合成資料。正式 snapshot、外部 writer 排空、平台 artifact 切換及正式資料復原必須另有操作證據，本文件不宣稱它們已完成。
