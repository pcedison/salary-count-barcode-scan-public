# LINE 考勤 Cloud Run 適配與隔離驗證

日期：2026-10-29（Asia/Taipei）。此文件記錄本機實作與實測；最終驗證數字於下方彙整，不代表正式環境已部署。

## 範圍與資料安全

來源為 `pcedison/salary-count-barcode-scan-public`，基準 `91cfc847b5e4c26504f05690106b5d6311463008`，分支 `codex/attendance-cloudrun-20261029`，套件版本仍為 2.2.9。本次只在隔離 worktree 修改，沒有操作其他專案、原始 checkout、Zeabur／Cloud Run 正式服務、正式 LINE、正式 PostgreSQL、正式 `.env` 或舊備份。

測試 runner 只繼承作業系統必要環境，禁止讀取 dotenv 與非 loopback 網路；資料庫為隨機埠、獨立名稱、虛構資料的 PostgreSQL 17.11 Docker fixture。備份真資料庫測試還核對 container 完整 ID、所有權 label、用途、image、建立時間、running、127.0.0.1 port mapping、tmpfs 及無 host data mount，只有通過後才接受實際 container 內部 IP。安全檢查未改成任意接受私有 IP。

## 兩個原 P2 的修復

| 問題 | 實作 | 驗證方式 |
|---|---|---|
| 寫入成功但回應遺失，再送會誤切換上下班 | 送出前持久保存同一 UUID／原 payload；出勤與回執同交易；重送取回原結果；前端不自動重試 POST | 真 PG 重播與回滾、手機尺寸 Chrome 提交後斷回應再核對 |
| 兩個請求同時讀到空狀態而重複上班 | 與條碼共用員工 advisory lock、employee／出勤 row lock、含 xmin 的狀態版本 | 真 PG 並行測試、兩個 Chrome 分頁持舊狀態收到 409 且無額外寫入 |

新增的保護包含同一 LINE 身分核對、拒絕不同內容沿用 UUID、已停用／刪除員工限制、原寫入暫停限制、rate limit、no-store，以及新表 RLS 與匿名角色撤權。新 schema 只透過明確管理工具建立，HTTP runtime 不自動 DDL。

最終 review 另補：伺服器時間＋單調時鐘避免手機時間偏差；拒絕下班早於上班；多分頁 Web Locks 預留事件＋比對原事件後才更新狀態；TLS URL 覆寫拒絕；明確保留既有 AES 模式與原金鑰引用。未知／過期事件不悄悄換成新時間或新 UUID。

## Docker 與 Cloud Run

保留 Node 24.16、Chromium、中文字型與非 root 容器；明確 LIFF build arg、排除 `.env*`／備份／資料庫／憑證、加入健康檢查與 SIGTERM。新主機產生器只產生待審 JSON：min1、max1、CPU always allocated、gen2、digest 映像、固定 secret 版本、單一 HTTPS origin、GCS FUSE 掛載。沒有呼叫遠端部署。

真 GCS 掛載證據不符時拒絕啟動；PDF／備份使用唯一檔名，Cloud audit 送 stdout。自動備份／月結／清理暫停，必要薪資規則仍一次性載入。常駐仍會遇到平台重啟，max1 也不能取代跨 revision 鎖。

備份 authority v4 保存 LINE ledger；還原不得刪改目標已有回執。真 PG 測試涵蓋 v4 roundtrip、owner FK、逾期原事件重播、舊備份拒覆寫零部分寫入與 receipt insert 失敗全交易回滾。

## 指令與最終結果

執行目錄：此 repository 的隔離 worktree 根目錄。

一般測試入口：`node scripts/verify-attendance-isolated.mjs all`，內部執行 `npm test`、`npm run check`、`npm run build`，產生各指令 exit code、來源 SHA、Node/npm 版本、測試數與安全守門統計。真 PG、Docker 與瀏覽器使用各自已隔離的 fixture，詳細紀錄位於 ignored `tmp/implementation-20261029/`；不將測試資料庫或備份加進 Git。

| 實際執行 | 結果／證據 |
|---|---|
| `node scripts/verify-attendance-isolated.mjs all` | npm test **1028 通過、0 失敗**；12 個 PostgreSQL case 在一般 suite 略過、另行實跑；112 檔通過、1 檔需 PG；check／build／runner 全部 exit0 |
| LINE repository＋route 獨立驗證 | **22/22**，其中真 PostgreSQL **12/12**；前述略過項已全部實跑 |
| `node scripts/test-payroll-backup-real-db.mjs`（已驗證 owned Docker manifest＋全新隨機測試庫） | **51/51** 真 PostgreSQL 備份還原驗證通過 |
| Cloud／Docker 受影響測試 | 12 檔 **92/92**，另修後 runtime 初始化 **3/3**；包含在對應整套驗證中，不重複累加 |
| 舊部署工具保護／產生器 | 4 個 shell stub 情境、shell syntax、manifest CLI 乾跑通過；無遠端修改 |
| 最終 `docker build`＋隔離 runtime smoke | **6 組通過**：entrypoint LF、非 root UID/GID1000＋NoNewPrivs、live／ready200、頁面資產、stop/start 後隔離檔案與 PG 哨兵保留、Cloud 假／缺掛載拒啟；534 個 dist 產物逐檔 SHA 與本機正式 build 完全一致，差異0 |
| Git 範圍檢查 | `git diff --check` exit0；沒有 staged 檔案；變更清單無資料庫／備份／憑證檔，常見高風險 credential pattern 無命中 |

完整一般驗證證據：`tmp/implementation-20261029/verifier/all-2026-10-29T05-03-32-941Z/summary.json`、`tests.json`、`test.log`、`check.log`、`build.log`。Node v24.16.0／npm11.13.0；測試前後來源 SHA 不變；沒有不完整 guard 檔，觀察到非 loopback 連線嘗試 0、dotenv 內容讀取嘗試 0。另對守門自身做故障注入，確認主程序／worker 在讀內容或建立外連之前拒絕，不把零嘗試當成守門已測試。

真 PG 證據：`tmp/implementation-20261029/worker/summary.json`、`backup-tests.json` 及相鄰 log。測試 runner 因需要具體隔離資料庫連線而不提供可直接指向正式庫的複製指令；所有真資料庫連線均由 fixture 產生，未在此文件或 Git 保存憑證。

最終本機映像：`attendance-isolated:20261029`，image ID `sha256:cf8303739bd8fb38c136c3d9e1f8c98cf8b6a986d4d225747fedc8b3f664439a`。沒有上傳 registry。建置命令為 `docker build --label owner=attendance20261029 --build-arg VITE_LIFF_ID= --tag attendance-isolated:20261029 .`；空 LIFF ID 只供本機 OAuth fixture，正式映像必須另外用已核對的真 LIFF 公開 ID 建置並驗收。

Docker 證據：`tmp/implementation-20261029/verifier/docker-build-2026-10-29T05-05-58-562Z/result.json`、`docker-smoke-76f8b8d72a/result.json`、`artifact-parity.json`、`cleanup.json`。建置前後來源 SHA 不變；後端 `dist/index.js` SHA256 `6e2c5e77b537bb9dd9632643a836e552369e80906d65185461e34ad1a8addb9e`；前端 `ClockInPage-BRa2m3NG.js` SHA256 `db99673de972930626d784da0f87e4ddbd5392b2592944f84c9bdd9bb2b96cd9`。

清理：已核對身分後停止瀏覽器 fixture 程序、移除本次自有 PostgreSQL／smoke containers、volumes、networks；64847／59021 無監聽，owner label 查詢無剩餘容器。保留測試 log、虛構資料截圖與最後映像供審閱。沒有刪除使用者原有容器或資料。

## 實際瀏覽器驗證

使用 Chrome 真實瀏覽器工具，手機 viewport 390×844、桌面實際 viewport 1366×900。頁面為本次真實 build、打卡 route／repository 與隔離 PostgreSQL；僅 LINE 登入 session／通知由測試 fixture 替代。沒有將 API 測試稱為手機瀏覽器操作，也沒有宣稱已使用實體手機或 LINE App。

第一輪操作結果：

1. 初次開啟零寫入；連點「確認上班」只有一個 POST、一筆出勤。
2. 重新載入仍顯示原上班回執；準備下一次只取得狀態，必須再確認才寫入。
3. 下班提交後故意中斷回應，畫面顯示未確認；按「確認原次」取回下班回執，沒有新增 POST／出勤。
4. 更換虛構員工不混用 journal；401 後重新登入，沿用同一 eventId 與原時間完成打卡。
5. 提交後登入到期，關頁重開先顯示登入；恢復登入後顯示原回執，沒有自動 POST。
6. 兩分頁同一狀態，第一頁上班成功，另一頁收到 409；沒有誤寫下班。核對最新狀態／返回頁面也不自動寫入。
7. 成功、未確認、衝突畫面文字與按鈕可見；手機與桌面無水平溢出。前端為 Vite 雜湊檔名，使用新 build 後重新載入核對，不僅檢查套件版本。

第一輪結束有 3 筆出勤、5 個成功回執、7 個 POST（包括一次 401 與一次 409），沒有多餘上下班效果。

最終版在同 origin、同隔離 DB 重建並重啟 fixture 後補驗：

- 舊分頁 event A 下班提交後延遲 14 秒回應；另一頁先查回 A 回執，再明確送 event B 上班並故意丟棄成功回應。A 真實延遲回應抵達時顯示「不會以舊回應覆蓋紀錄」；兩頁重新載入均恢復 **B 上班**，沒有遺失新 pending。事件紀錄證明 A response 已釋出且並未因斷線被取消。
- 兩頁同時按確認下班，其中一個 request 延遲進 route；Web Lock 讓兩次 request 共用同一 UUID，兩頁顯示相同下班成功，只新增 **1 回執、1 次通知、1 個業務效果**。
- 最終累計 4 筆出勤、8 個回執；重啟 fixture 後上述操作共 4 個 POST、3 次新事件通知。保留兩輪事件證據，不混淆重啟後的 counters。

可回讀證據：`tests/fixtures/attendance-browser.ts`、`tmp/implementation-20261029/verifier/browser-state.json` 與 `browser-history-20261029T050013879Z/`。操作流程與 fault mode 均使用 fixture；重新演練時必須建立新的隔離 fixture，不可對正式服務打故障請求。

虛構資料截圖：[最終手機回執](evidence/cloudrun-attendance-20261029/mobile-final-recovered.jpg)、[回應遺失](evidence/cloudrun-attendance-20261029/mobile-response-lost.jpg)、[舊狀態拒絕](evidence/cloudrun-attendance-20261029/mobile-state-conflict.jpg)、[桌面重開回執](evidence/cloudrun-attendance-20261029/desktop-reopened.jpg)。

## 過程發現與修復

- 初次完整測試有 3 項失敗：備份分類漏列新 ledger、測試重用已讀 Response、測試 TEMP 落在 workspace 觸發既有安全守門；已分別修正，沒有降低正式安全條件。
- 原真 PG 備份 runner 因 Docker 內部位址與 loopback 不同而拒絕；增加可驗證所有權與實際網路對應，仍拒絕未確認來源。
- 首次 Docker image 建置成功但啟動 exit255：Windows CRLF shebang。Dockerfile 在映像內正規化 entrypoint 換行後重建，啟動／重啟成功。
- Docker 與本機 production build 比對時發現 builder 繼承 development 模式，前端帶入開發用 runtime。改為明確 `RUN NODE_ENV=production npm run build`，保留安裝建置所需 dev dependencies；最後另重建容器並比對實際資產。
- 新 TLS 共用 `.mjs` 初次 typecheck 缺型別宣告（TS7016），補 `.d.mts` 後整套 check 通過。驗證 runner 曾因 worker 結束時留下空 guard 統計檔而 exit1，改成 atomic rename 並列缺檔後重跑，最終 runner exit0且無缺檔；沒有把這些中途失敗隱藏成一次全綠。
- 桌面截圖曾一次逾時，重取成功；不影響打卡結果。

## Jev 真實協作

Jev 在設計／調查階段排序剩餘語意風險，選擇「重開／重掃意圖」後先追讀成功頁、路由與重試流程；因此納入重開零寫入、明確下一次意圖、持久原事件與不保證通知已送達等驗收。實際 receipt `4aca7140a45a406a84564b968c318ffd`，model `jev-1.13.0`，input/output 6210／73 tokens，API 1 次、非快取。8 段來源原文的雜湊、byte offset、payload 在送出與採用前核對；choice 集中程度不是正確率。

原始可回讀索引：`tmp/implementation-20261029/review/ledger.json`、`spec.json`、`contract.json`、`evidence.json`。spec SHA256 `12c6f23ad88da2ca9b29f0773464f00c0310a513b334c403983e6597081f997e`，contract SHA256 `63ca92134caba72d49746e8582d6bd9f9e2cbb6eeac19c30f26475ffdf127967`。最後實作驗收由實際測試及 Reviewer 完成，沒有用 Jev confidence 代替測試或授權；固定 Git／計算／格式檢查未製造額外 API 請求。

## 提交前 CI 銜接驗證

本輪提交前核對 70 個任務檔案，排除實際資料庫、備份、dotenv、憑證與 ignored 原始測試紀錄；保留 SQL 結構遷移、範例設定及虛構資料截圖。高風險憑證 pattern 掃描與人工審閱未發現實際憑證。公開文件移除個人工作路徑與內部部署識別。

- PR 的 LINE 真 PostgreSQL 測試使用 CI 新建的 loopback fixture。以新建 tmpfs PostgreSQL 17、127.0.0.1 隨機埠執行 `node node_modules/vitest/vitest.mjs run server/repositories/lineClockInRepository.postgres.test.ts --config tmp/publish-20261029/verifier/vitest-isolated.config.ts`，**12/12 通過**；此本機隔離設定驗證 CI 指定的同一測試檔，測試庫清理後無殘留。這是既有 12 項的重跑，不另累加案例數。
- Docker CI 的 root-volume 檢查改用明確 `APP_VOLUME_ROOT`。使用本次最終映像及 `network none` 實跑：`/live` 200、PID1 為 node、NoNewPrivs=1、HOME 與預設 runtime 正確、掛載根仍為 root、備份與 log 子目錄由 node 擁有且可寫。
- 外部資料庫 Acceptance job 改為手動明確選用，預設關閉。YAML parse 與條件核對通過：PR 即使帶 true 也不執行，手動 false 不執行，只有手動 true 才執行；建立 PR 不使用既有外部測試庫 secret。
- CI 銜接驗證資料保留在 ignored `tmp/publish-20261029/verifier/report.json` 與 `line-pg-tests.log`。第一次因驗證器 Windows 路徑跳脫而未進入產品測試，修正後重跑通過；兩次建立的容器與 volume 均核對 ID／owner label 後清除。此次未改應用程式來源，先前完整測試、build 與瀏覽器證據仍對應提交版本。

PR 首次執行的主要測試、手機 UI 與 Docker smoke 通過；CodeQL 指出隔離瀏覽器 fixture 的 binding-status 讀檔入口缺少限流。於 JSON、session、control 讀檔、路由及靜態資源前加入每分鐘 300 次的全域限流，沒有略過或關閉掃描。

以 `node tmp/publish-20261029/verify-fixture-rate-limit.mjs` 啟動修改後真 fixture 與全新 loopback／tmpfs PostgreSQL：正常 binding-status 200；300 次請求允許，後續 binding-status、無效 JSON POST、正常 JSON POST 及 settings 均回 429。拒絕前後的 JSON／session／control 讀取計數不變，沒有 Set-Cookie 或出勤／回執寫入。測試程序與容器均核對身分後清理；證據為 `tmp/publish-20261029/rate-limit-dc39d2f2e8/report.json`。

修補後再次執行 `node scripts/verify-attendance-isolated.mjs all`，1028 通過／12 PG 略過、check／build exit0；本輪沒有重複計算先前已實跑的 PG 案例。來源在測試期間不變，534 個正式 build 產物 SHA 與先前驗收映像一致。完整證據位於 `tmp/implementation-20261029/verifier/all-2026-10-29T06-46-45-386Z/`；新 head 的 CodeQL 與其餘 CI 結果以 PR checks 為準。

本輪 Git 範圍、來源 hash、憑證掃描及固定 CI 條件屬確定性核對，沒有新增 Jev API 呼叫；既有實際語意協作收據列於上一節。

## 正式切換尚缺的條件

1. 確認 Cloud 專案、區域、計費預算、正式 origin、Artifact Registry digest、runtime 服務帳號及最小 IAM。常駐不是零停機保證。
2. 對照原有 Secret Manager 內容與 AES 模式，保留原資料加密／備份／session 金鑰；明確核對資料庫 schema、TLS、runtime 權限與 RLS，再以核准流程套 LINE ledger migration、初始化 session 表。
3. 真實 GCS FUSE mountinfo、私人 bucket、目錄與 marker、物件保留政策；實測寫入、重啟後讀取、備份還原。一般 Docker volume 測試不能代替真 GCS 驗收。
4. LINE Console callback／webhook／LIFF endpoint／build ID／QR 入口對照，以及 iOS、Android LINE 內和外部瀏覽器真機驗證。尤其驗證 Web Locks、持久 storage、重新登入、弱網和時間基準。
5. 舊入口停止新增寫入並排清未確認事件，確認同一份 ledger；移轉窗口、資料筆數核對、唯一寫入主機與可回復方案。跨 origin cookie／手機 journal 不會自動搬遷。
6. 明確安排自動背景作業停用期間的備份、薪資與保留清理人員／頻率／證據；薪資寄信與詳細稽核追查仍須補設定及驗收，不因打卡可用就宣稱完整薪資維運已搬完。

其他已知限制：Web Locks 缺失會阻擋新打卡意圖，既有 pending 仍可查詢／沿原事件恢復；通知只盡力傳送，不保證必達。管理員其他出勤寫入尚未全面共用員工 advisory lock，本輪不改造無關管理功能；切換窗口應停止並行管理修正。全套既有歷史真 DB／正式 smoke 腳本並非每個都執行，本輪實跑範圍以上述一般 suite、LINE 與備份真 PG 為準。

上述實作驗證完成時，尚未 commit、push 或建立 PR，正式服務 SHA 與 Cloud／LINE 帳戶設定均未改變。後續依授權將修補與核對過的文件提交至功能分支供 PR 審查；不合併、不部署。先前驗證摘要 JSON 的 Git 狀態描述的是該次驗證時點，後續 commit／CI 以 PR 紀錄為準。

最終 Reviewer 已逐一複核提出的阻塞修補，沒有剩餘必修發現；此結論限本次來源與隔離證據，不等於上述正式切換條件已通過。
