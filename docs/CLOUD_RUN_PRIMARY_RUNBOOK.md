# 考勤系統 Cloud Run 主機操作手冊

2026-10-29；適用 `barcode_scan_V3` 的 Cloud Run 常駐 **service** 候選。這次只完成本地程式、容器、設定產生器與隔離驗證，沒有部署、建立付費資源、讀寫正式資料或切換 LINE 入口。Railway 暫時移出方案；不要使用歷史雙平台流程部署新主機。

## 已完成與尚未完成

新主機設定提供 min instance 1、max instance 1、CPU always allocated、gen2、非 root Node＋Chromium，以及外部 PostgreSQL與GCS FUSE檔案掛載。產生器只寫本機JSON manifest，沒有網路或部署動作。

常駐設定仍可能因平台維護、健康檢查、更新或故障而重啟；min instance 1不保證單一程序永不停止，也不保證零停機。在途工作及資料持續性必須依下列恢復與掛載程序驗證。

**Cloud Run 所有背景工作保持停用**：不在啟動時清理員工、不自動清理保留薪資、不自動備份、不跑月結或OAuth清理。這不是「完整薪資排程已遷移」；跨revision排程ownership／可安全恢復月結仍待實作。即使max instance=1，滾動更新時舊新revision仍可能同時存在，不能以此取代排他鎖。

## 執行設定

| 設定 | Cloud Run 主機契約 |
|---|---|
| `APP_DEPLOYMENT_MODE` | 明確為 `cloudrun`；K_SERVICE存在而未設定此模式時拒絕啟動 |
| `APP_BACKGROUND_SERVICES` | 必須 `disabled`；本機／一般Docker仍可明確enabled，維持原有行為 |
| `SALARY_AUTOMATION_ENABLED` | 必須 `false`；不因CPU常駐就自行啟用排程 |
| `APP_AUDIT_SINK` | 必須 `stdout`，不在GCS FUSE上append稽核檔 |
| `APP_PUBLIC_ORIGIN` | 單一完整HTTPS origin，無路徑／query／尾端斜線 |
| `ALLOWED_ORIGINS` | 必須與APP_PUBLIC_ORIGIN完全相同 |
| `SALARY_AUTOMATION_PUBLIC_BASE_URL` | 必須與APP_PUBLIC_ORIGIN完全相同，供人工PDF操作使用 |
| `LINE_LOGIN_CALLBACK_URL` | 啟用LINE時必須為該origin的 `/api/line/callback` |
| `APP_STORAGE_MOUNT` | 專用GCS FUSE掛載根，例如 `/mnt/attendance` |
| `APP_STORAGE_BUCKET` | 經確認的既有私人bucket名稱，與卷識別metadata一致 |
| `APP_RUNTIME_DIR` | 掛載下已存在目錄，例如 `/mnt/attendance/runtime`；PDF位於其salary-reports子目錄 |
| `APP_BACKUP_DIR` | 掛載下已存在目錄，例如 `/mnt/attendance/backups` |
| `APP_LOG_DIR` | stdout模式不使用，不以本機目錄假裝持久稽核 |
| `DATABASE_URL`等憑證 | 使用Secret Manager固定版本引用，不放manifest明文／build args／Git |
| `SESSION_SECURE`／`TRUST_PROXY` | true；保留原有登入與來源檢查 |

Cloud Run不允許 `PGSSLREJECT_UNAUTHORIZED=false`。原一般Docker／本機例外政策沒有擴大；外部資料庫憑證鏈需在實際環境驗證。app仍不會從正式workspace `.env`偷載設定，production guard保留。

外部 `DATABASE_URL` 也不可用 query 參數覆蓋 TLS：只接受 `sslmode=verify-full` 或省略 SSL 參數，拒絕 `no-verify`／`disable`／`require`、`ssl*` 檔案參數及 `uselibpqcompat`。相同守門用於新 schema 管理工具，避免 node-pg 以網址設定覆蓋程式的憑證驗證。錯誤不輸出完整連線字串。

## 持久檔案：先驗證掛載，後啟動

Cloud Storage FUSE不是完整POSIX檔案系統，不能依賴多程序檔案鎖或同檔寫入排序。新模式只把PDF／備份保存為UUID唯一檔名，不以同一月別檔名覆蓋；cloud備份不自動刪除舊檔。需另設定與驗證bucket保留、版本、容量及生命週期政策，且不能自動刪掉仍有資料庫引用的PDF。[Google Cloud Storage掛載限制](https://docs.cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts)

啟動檢查同時要求：

1. 真實 `/proc/self/mountinfo` 有對應、可寫的 `fuse.gcsfuse` 掛載，不接受overlay、一般資料夾或bind mount充作GCS證據。
2. 掛載根有維運者預先建立的 `.attendance-volume.json`，內容形狀如下；只放非秘密的bucket識別。

   ```json
   { "format": "attendance-runtime-v1", "bucket": "your-existing-private-bucket" }
   ```

3. runtime及backup目錄已存在，經realpath解析後均在同一掛載之下，掛載不能在app workspace內。bucket使用implicit directories時可預先放置 `runtime/.keep`、`backups/.keep`，由經核准的維運步驟處理；app不會建立bucket。

任一證據不符就拒絕啟動，不能關閉驗證強行放行。真Cloud Run的mountinfo格式、IAM、bucket寫入／重啟後讀取仍未在本輪驗收；若平台證據格式不同，先讀取不含秘密的實際metadata後修正驗證，不把普通路徑列為白名單。

manifest掛載指定uid=1000、gid=1000、檔案0600、目錄0700；容器以node啟動，Cloud Run不允許root entrypoint自動chown。runtime服務帳號需限於指定bucket的必要物件權限及指定Secret Manager版本，不需部署／IAM管理權。metadata只驗識別與掛載事實，不替代實際資料持續性及備份還原演練。

## 稽核與查閱

Cloud audit直接輸出單行JSON，component為 `attendance-audit`，欄位限timestamp、operation、success與severity；不把原始details、姓名、IP、URL query或錯誤文字傳入平台日誌。既有一般file模式保留原行為。

Cloud模式下 `/api/dashboard/logs` 及 `/api/dashboard/logs/dates` 對有權限管理員回501與 `AUDIT_LOGS_EXTERNAL`，明示到Cloud Logging查閱，避免空清單被誤認為沒有事件。這些最小事件不能取代完整薪資／考勤業務歷程，詳細結果仍以受控資料庫紀錄核對。正式切換前確認Cloud Logging收件、保存期限、查閱IAM及匯出需求；stdout成功不代表已驗證雲端保存。

## 建置與manifest產生

Dockerfile固定Node24.16基底digest、包含Chromium與中文字型、以node執行。`.dockerignore`排除所有 `.env*`（包括舊 `client/.env.production`）、憑證、資料庫、暫存與日誌；本輪沒有修改正式LIFF。LIFF ID為非秘密建置參數，需明確提供與新入口對應的值：

```powershell
docker build --platform linux/amd64 --build-arg VITE_LIFF_ID=YOUR_PUBLIC_LIFF_ID -t attendance:review .
```

`deploy/cloudrun-primary.example.json`只含範例資源名、公開origin／LIFF ID及secret名稱版本，不含秘密。替換為經確認的非秘密設定；image必須為Artifact Registry完整digest，不能用latest。`liffId`會記在manifest annotation供核對，**不會替已建好的前端更換LIFF ID**；需對照實際映像建置證據。

`useAesEncryption` 必填，需與來源系統的 `USE_AES_ENCRYPTION` 一致，不能因漏填而默默改變新資料的保存方式。true 時必須引用既有 `ENCRYPTION_KEY` 與 `ENCRYPTION_SALT`；備份金鑰、身分資料金鑰與 salt 均不可在搬家時重新生成。範例的 true 只是展示設定形狀，沒有代表已查明正式系統的值；即使來源停用新 AES 寫入，仍須保留解開既有密文所需的原金鑰。

```powershell
node deploy/cloudrun-primary.mjs --config deploy/cloudrun-primary.example.json --output primary-review.json
```

輸出路徑必須不存在。此命令不執行gcloud、不建立任何雲資源；範例零值digest不能拿去部署。產生器固定origin、callback、storage與停用背景工作，不接受任意extraEnv或raw secret；secret引用使用數字版本。CPU常駐min1有持續成本，正式啟用需另確認預算，這次沒有啟用。

新服務帶 `attendance-role=primary` 標籤。歷史 `deploy-all.sh`／`cloudrun-env.sh` 在操作前只讀取服務metadata，遇primary標籤或無法確認目標就拒絕；它們不能把新主機改回standby來源／callback。仍不要用歷史工具管理新主機，也不要移除保護標籤。沒有在本輪停用或修改遠端workflow，遠端狀態須另外確認。

## 初始化、健康與安全切換

Cloud runtime不自動建立session表；先以核准管理流程確認 `public.user_sessions` 已初始化。新的LINE防重表使用顯式管理工具：

```powershell
node scripts/apply-line-clock-requests-schema.mjs --check
```

`--apply`是另行確認目標後才可執行的資料結構操作，本輪不對正式環境執行。runtime角色需對新表具適當權限及RLS policy；不要為了讓ready通過而開放anon／authenticated。

`/live`只判斷程序存活；`/ready`在cloud模式除資料庫連線外，還唯讀檢查session表、LINE receipt必需欄位、歸屬comment與RLS。缺結構回503，不自動DDL。完整欄位型別／索引／權限檢查由上述schema gate及部署前驗證完成。Docker HEALTHCHECK不能代替Cloud Run manifest的startup／liveness probe。

切換前至少核對：LINE Login callback、Messaging webhook、LIFF endpoint與ID、QR入口、新主機origin、session及新表migration、備份還原、檔案重啟持續性，以及桌面／手機LINE內與外部瀏覽器互動。舊入口須按同一切換窗口處理，不能讓兩套背景排程同時持有寫入權。

手機會先顯示「確認上班／下班」再寫入，重新掃碼／重載會保留原回執。前端使用伺服器時間加單調時鐘經過時間，避免手機時鐘略快而被拒；未知結果仍用原 UUID 與原時間核對。相同帳號的多分頁用 Web Locks 協調本地紀錄，不支援 Web Locks 或無法持久儲存時會在送出前拒絕，不能以無鎖模式繼續。必須在員工實際 iOS／Android LINE 版本驗收，並提供受支援瀏覽器或人工核對流程。超過五分鐘的未提交請求不自動補現在時間；這不是離線打卡佇列。

網址更換時，原 host-only session cookie 與該 origin 的本地待確認紀錄不會自動搬到新網址。相同 SESSION_SECRET 不能讓不同 hostname 直接延續登入。切換前須核對／排清舊入口待確認事件，通知重新登入，並保留舊事件 ledger；不能先清除手機資料來消除未確認狀態。

`APP_BACKGROUND_SERVICES=disabled`只禁止背景排程，**不是整台服務唯讀模式**：合法使用者的HTTP操作仍可寫入，session也仍可保存。無流量演練必須使用隔離DB與憑證；正式備援若要禁止所有業務寫入，需另設維護／網路存取措施。

## 月結中斷與人工維運

現有monthly run的 `running` 記錄不會被自動接管，重啟不會以「逾時」理由自動重寄。SIGTERM停止排程不等於在途PDF／寄信工作已完成；Cloud Run終止窗口可能中斷工作。遇到running／不明寄送結果時：

1. 停止新的月結觸發，確認該月份run、薪資record revision、PDF物件及郵件服務商紀錄。
2. 確認資料已提交與郵件是否送達；未有證據前不要直接把running改failed、不要按force重算重寄。
3. 保存收據與判定後，依核准的人工修復流程處理；若需要SQL狀態修復，先備份並審核確切條件，不能以本文件代替授權。

Cloud模式尚無自動備份／薪資月結／清理。**正式切換前必須指定操作人、執行頻率與核對紀錄**：管理介面人工備份及還原演練、每期薪資的人工核算與發送安排，以及OAuth state、員工與薪資保留清理。若現有介面沒有安全的人工操作入口，須先補上經審核的維運流程，不能以直接改資料或臨時開啟排程代替；這些安排未確認前不應正式切換。缺少跨revision ownership前，envValidator會拒絕開啟cloud背景工作。

備份 authority v4 包含 LINE 事件 ledger。舊 v2／v3 備份可以讀取與檢驗；目標已有回執時，任何會刪除或改動既有回執的還原都會在寫入前拒絕。考勤還原不一律要求空目標，但每筆既有回執必須原樣保留，且需通過既有維護與確認條件。不能以建立空 receipt 表就宣稱完整還原或重開流量，也不刪掉仍可能重送的紀錄來讓重試通過。

本輪主機 manifest 以 LINE 出勤為範圍，尚未搬齊薪資寄信的寄件人／SMTP 等完整非秘密設定；目前人工薪資寄送仍須使用已核准環境，或另完成設定對照與隔離寄信驗收。Cloud stdout 稽核只有事件類型與結果，缺少 actor／target／correlation，不能宣稱等同舊完整稽核追查能力；正式切換前需確認可接受的查核需求與受控保存方案。

## 本地驗證與平台限制

單元驗證涵蓋背景停用、保留清理不啟動、mount證據、origin／callback一致、audit輸出、immutable PDF命名、manifest乾跑及健康schema gate。Verifier另外執行全套typecheck／tests／build與隔離PostgreSQL、瀏覽器、Docker驗證；數字以最終報告為準。

本機Docker正向檢查使用 `APP_DEPLOYMENT_MODE=local`、`APP_BACKGROUND_SERVICES=disabled` 與明確外掛隔離資料目錄，驗證restart前後檔案存在；這不叫真GCS驗收。Cloud負向檢查要求沒有真gcsfuse掛載的容器拒啟。測試程式可注入合成mountinfo作單元驗證，runtime沒有「跳過mount檢查」環境開關。

尚未驗證的正式平台條件包括Cloud Run CPU／shutdown、Secret Manager IAM、GCS FUSE具體mountinfo與寫入持續性、Supabase TLS／runtime權限、LINE Console與真機互動。程式、Git分支、映像建置和正式部署狀態分開追蹤；本輪未部署。
