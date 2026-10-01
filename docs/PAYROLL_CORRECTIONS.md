# 已結算薪資更正

歷史薪資保存的是結算時的金額與出勤快照。原編輯畫面只能修改已存在的出勤列，沒有新增假日的入口；原 PATCH 又會從目前的暫存出勤和設定重新計算，無法安全地重建已結算月份。結算後補登應修改指定的歷史快照，並保存修訂，不應重跑原月份或更動目前出勤。

## 操作與金額

在歷史紀錄選定員工／月份後按「假日更正」，輸入日期、類別、原因和差額處理。預覽會顯示原金額、新金額和差額；取消或返回不寫入資料。管理者核對並確認後，系統才一次保存更正後的快照與更正紀錄。

- 新日期用「補登新日期」；已存在出勤或假日的日期必須明確選「更正既有紀錄」，保留原打卡時間。
- 日期不得跨月或重複。假日出勤必須有真實、有效的原打卡時間；不能由新增假日創造工作時間。
- 沿用 `calculateHolidayPayAdjustments` 的現有規則。國定假日未出勤已包含於月薪，補登可能只有分類變更、實付差額為零；不能把它當作額外一日薪資。假日出勤、病假、事假、颱風假及臨時停止上班上課的差額按原結算基準計算。
- 保留原底薪、加班、津貼和特休折現，不依目前設定重算。新的結算保存 `holidayCalculationBaseSalary`；既有紀錄第一次更正以儲存底薪作為基準。曾在舊系統改過底薪、但沒有原基準的紀錄可能無法完整核對，不能假設其歷史公式已被還原。
- 特休的更正需要結算時餘額快照，目前歷史模型沒有，因此拒絕補登或替換特休。缺失、矛盾或無法精確配對的扣款／出勤快照也會拒絕，交由管理者核對。
- 一般歷史金額編輯同樣需原因、版本和差額處理，服務端計算總額；不允許 `X-Force-Update` 或修改員工、月份及已封存出勤。

資料模型沒有既有「已發薪」欄位，不能從結算推斷付款。每次更正必須選擇：未發薪（採更正後金額供後續核對）、已發薪（保留差額待管理者另外處理）、狀態待核對（差額待核對）。這個選擇記錄處理意圖，**不代表付款已執行**。所有模式均不付款、不寄信、不通知員工，也不新增自動補發機制。

## 一致性、權限與紀錄

預覽／確認及歷程均需現有管理者 session；寫入只接受 JSON 並拒絕跨來源瀏覽器請求。假日預覽 token 有效十分鐘，綁定完整原快照、版本、請求內容及管理者 session，以服務端 HMAC 簽章。

確認在 PostgreSQL transaction 中鎖定指定薪資列，核對預覽後重新計算，一次更新 projection 及新增 journal。任何失敗全部回滾。相同 idempotency key、請求、預覽與操作者只產生一次修訂；不同請求不能共用 key。另一操作已更新版本時回 409，需重新讀取和預覽，不能覆寫。原金額保存在第一次修訂的 before snapshot，後續每次保存 before／after／delta、原因、日期及處理意圖。操作者是 session 的不可逆代碼與角色；共用 PIN 系統無法識別實際個人。

journal 不另複製姓名、employee snapshot 或出勤的 UI 補充欄位；日期、打卡、金額等必要證據仍是敏感資料。原因是管理者自由文字，應避免寫入不必要個資。對外歷程 API 僅回白名單 metadata，沒有原／新完整快照、session 代碼、token 或 request hash。應用程式不提供 journal 更新／刪除入口。

所有既存薪資均不得由 CSV 覆寫，帶修訂的快照也不能由 CSV 重新建立，避免繞過更正歷程；CSV 只用於明確目標的新／缺失紀錄。有更正的薪資不能由一般刪除，以免斷開歷程。現有員工保留／匿名化政策與年限沒有更動；匿名化流程鎖定同一薪資列，避免以過時快照覆蓋更正。保留到期的既有 projection 刪除後，FK 置空且 journal 的 `original_record_id` 和必要證據保留。此 PR 不替 journal 發明保留年限；釋出前需依組織政策另行決定其保存及授權流程。

## API 與釋出前置條件

- `GET /api/salary-records/:id/holiday-corrections`：白名單修訂歷程。
- `POST /api/salary-records/:id/holiday-corrections/preview`：`revision`、`holidays[{date,holidayType,name,mode}]`、`reason`、`paymentHandling`；回 before／after／delta／previewToken，不寫入。
- `POST /api/salary-records/:id/holiday-corrections`：同上，加 `previewToken` 及 UUID `idempotencyKey`。
- `PATCH /api/salary-records/:id`：金額輸入加 `revision`、`reason`、`paymentHandling`、UUID `idempotencyKey`；衍生總額由服務端計算。
- 歷史列表使用有上限的服務端分頁、員工／年度／文字篩選；`GET /api/salary-records/finalized-months` 只回結算範圍摘要。

本修補不自行部署或執行正式 SQL。釋出需經授權，由操作者先備份並審閱／套用根目錄 `payroll_corrections_schema.sql`，再部署相同 source revision。SQL 新增 revision、可空原計薪基準、journal 與查詢索引，不回填或改寫薪資金額；在隔離 PostgreSQL 已驗證可重複套用。journal 啟用 RLS 並撤銷 public／anon／authenticated 的權限，現有表的政策不變；部署時應確認服務端 DB 角色確實具有 journal 存取權。缺 schema 時功能會失敗，不應繞過交易或權限。

交易回歸可用 `npm run test:payroll-db` 重現。須另外建立全新、空的 loopback PostgreSQL database，名稱為 `payroll_test_*`，並明確提供 `PAYROLL_CORRECTION_TEST_DB_URL` 和 `PAYROLL_CORRECTION_TEST_DB_DISPOSABLE=1`；不能使用 production URL。runner 不讀 `.env`、不回落 `DATABASE_URL`，拒絕外部／不符命名／已有 tables 的目標；每次重跑需新的 scratch database。CI 使用獨立臨時 PostgreSQL container 和公開測試憑證，在 Linux runner 的 host network 僅綁定 `127.0.0.1`，讓 server address 也通過 loopback 守衛；無論測試成敗都移除該 container。


公開版另外保留臨時停止上班上課類別及原扣款規則。自動月結的批次保存仍使用公開版 repository：已存在更正歷程的列拒絕強制重算；沒有歷程的普通紀錄必須攜帶計算時的版本，交易鎖定後再次比對，不能覆蓋並行編輯。完整維護、備份與回退流程見 [釋出 runbook](PAYROLL_CORRECTION_RELEASE_RUNBOOK.md)。

新結算及未更正紀錄的完整強制重算，會保存本次計算實際使用的 `baseSalary` 為 `holidayCalculationBaseSalary`。一般歷史金額更正保留原基準；CSV 還原僅保存檔案提供的基準，缺失時保留 legacy null，不從目前設定或顯示底薪推測。
