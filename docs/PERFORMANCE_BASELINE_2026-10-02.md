# 合成效能基準（2026-10-02）

## 結論與狀態

本輪以全新、只監聽 loopback 的 PostgreSQL 建立可重跑基準。100、1,000、
10,000 筆合成資料均通過筆數與固定金額檢查。量測路徑沒有觀察到 N+1 查詢；
目前沒有足夠證據需要修改產品效能邏輯，所以本輪不做效能改寫或索引 migration。

這是本機研究性基準，不是正式站 SLA、容量保證或已核准的效能門檻。將來若採用
P95、回應大小或記憶體門檻，須先用代表性工作負載、併發與正式平台資源校準。

## 版本與方法

- Git 基底：`342b49c34f6749e811faf530fe65683c46b31f43`，package 2.2.7。
  量測包含本輪工作分支當時的來源；原始報告另外保存實際載入路徑的來源 SHA256，
  並於量測後重新核對相同。此狀態不能代表這些本地修改已經發布。
  後續薪資快照修復與 benchmark 啟動錯誤遮罩另有變動；原始結果保留量測當時
  的雜湊，不宣稱與最終所有檔案相同，也不從後續修改推定新的效能改善。
- Node 24.16.0、PostgreSQL 17.6、Windows 10.0.26200。
- AMD Ryzen 7 8700G、16 邏輯核心、約 31.1 GiB RAM。
- PG `shared_buffers=128MiB`、`work_mem=4MiB`、`fsync=on`、
  `synchronous_commit=on`；應用資料庫池上限 10。
- 每個資料量均為 100 位合成人員、相同數量薪資與出勤列，每筆薪資含 22 日快照。
- 每條路徑暖機 5 次，再以單一併發量測 30 次，P50/P95 採 nearest-rank。
- schema、seed、ANALYZE、正確性斷言與 EXPLAIN 位於計時範圍外。
  HTTP 計時包括 fetch、傳輸與 JSON 解析；SQL 計數成本位於計時範圍內。
- 原始報告保存每次樣本、實際 query count、EXPLAIN ANALYZE BUFFERS、
  固定薪資合計與應用程序記憶體；記憶體數字不含 PostgreSQL。

## HTTP 結果

單位為 P50 / P95 毫秒；薪資與出勤列表每頁 50 筆。

| 資料量 | 薪資首頁 | 薪資末頁 | 薪資搜尋 | 已結算月份 | 出勤首頁 |
| --- | --- | --- | --- | --- | --- |
| 100 | 6.149 / 9.653 | 6.527 / 10.551 | 2.135 / 2.745 | 1.313 / 1.952 | 1.569 / 2.406 |
| 1,000 | 10.019 / 28.798 | 10.029 / 24.356 | 4.601 / 6.769 | 3.859 / 8.427 | 1.886 / 2.708 |
| 10,000 | 7.216 / 10.840 | 8.178 / 12.829 | 12.007 / 16.834 | 26.098 / 41.005 | 2.105 / 3.431 |

1,000 筆結果的波動顯示單輪微基準不能證明延遲必然隨資料量單調成長，
也不能在沒有控制條件的前後對照下宣稱最佳化改善率。

## Repository 與資料庫結果

10,000 筆時的 repository P50/P95：薪資首頁 2.886/3.845 ms、
末頁 4.611/5.748 ms、搜尋 6.977/8.582 ms、出勤首頁 1.060/1.564 ms。
列表每次固定 2 個 SQL，已結算月份固定 1 個 SQL。

已結算月份為未分頁結果，10,000 筆回應 620,504 bytes，該階段應用程序
observed heap 91.16 MiB、RSS 277.81 MiB。它是已量測的線性成長點，
正式平台是否形成瓶頸仍未驗證。薪資搜尋有掃描成本，但本輪延遲不足以證明
需要新的索引或改變查詢契約。

10,000 筆固定合成金額為應發 303,000,000、扣款 10,000,000、
實領 293,000,000；逐筆驗證 30,300 − 1,000 = 29,300。
這只驗證資料讀取一致性，不能替代薪資業務規則測試。

## 已通過與未驗證的界線

已通過：實際 salary/attendance 路由、requireAdmin 與 repository 的合成讀取；
量測前注入合成管理員 session，沒有真正登入或使用正式憑證。
獨立新空庫的薪資更正測試另為 30 passed，backup/restore 測試 48 passed，
兩者均為 0 failed、0 pending；它們是功能正確性證據，不是效能樣本。

未驗證：正式站流量、完整 server middleware 與 session store、反向代理、TLS、
rate limit、瀏覽器呈現、PDF 生成、大型備份／還原效能、PDF 與備份併發、
月結寫入併發、長時間 memory leak、Docker/Linux 相同負載與正式平台容量。
沒有向正式站執行負載測試，也沒有將略過項目算成通過。

## 重跑與安全邊界

先建立全新的 loopback `payroll_test_*` 空庫，再執行：

```powershell
$env:PAYROLL_CORRECTION_TEST_DB_DISPOSABLE='1'
$env:PAYROLL_CORRECTION_TEST_DB_URL='postgresql://<local-role>@127.0.0.1:<local-port>/payroll_test_<new_unique_name>'
node scripts/benchmark-payroll.mjs
```

runner 不載入 `.env`，不使用 `DATABASE_URL` fallback，拒絕遠端主機、URL options、
不符命名的資料庫與非空 public schema；連線後再次核對實際主機、DB 名稱與 lock。
子程序採環境白名單，只取得明確的測試 URL 與隔離 runtime 路徑。
HTTP 只監聽臨時 loopback port，未啟動郵件、LINE、排程或正式 server bootstrap。
schema 及合成資料只寫入這個新測試 DB；沒有 truncate、drop 或清空既有 DB。

原始成功報告為本機 ignored `tmp/performance/benchmark-1790928418191.json`，
含樣本、計畫及來源雜湊。先前兩次 harness 啟動失敗另留 log；修正不存在的
測試權限 enum 後以另一個新空庫量測，沒有將失敗樣本納入成功統計。

本階段沒有額外 Jev 請求；指定的固定測量、精確查詢與算術由程式執行，
未將它們宣稱為 Jev 語意審核。
