# 2026-10-02 安全、薪資邏輯與效能檢測

本次使用最新公開 `main`（`342b49c34f6749e811faf530fe65683c46b31f43`，2.2.7）建立隔離分支。
所有重現與寫入測試均使用合成資料。正式環境僅透過已連接 Chrome 唯讀檢查，沒有更正、重算、付款、寄信、還原、migration、清除或部署。

## 正式基準與備份

- 2026-10-02 台北時間約 15:54～16:12，GitHub main 與 Zeabur 運行中的 PR #107 對應；產品設定頁顯示 2.2.7，Chrome 載入 `/assets/index-B_NpHSpB.js`。本輪未直接取得 runtime Git SHA 或重算正式 bundle 雜湊，版本字串不能代替 SHA 證明。
- Zeabur 磁碟頁本輪明示「尚未掛載任何硬盤」。容器 `/root/.local/state/barcode_scan_V3` 仍有 backups、logs、salary-reports 與 recovered-runtime 目錄。檔案存在不能證明下次容器替換後仍在。
- Chrome直接開啟正式`/api/health`被瀏覽器端阻擋；本輪健康探針記為未驗證，不推論正式服務故障，也未改用其他通道繞過。
- 本機私人原生 baseline、final-v3 備份 bytes/SHA256 與 manifest 一致，兩份歷史實際還原報告與 archive hash 綁定相同。2.2.7 封裝及 22 筆回填 metadata 亦相符。本輪沒有解密、啟動或重新還原正式資料副本。
- 本輪另以全新 loopback PostgreSQL 17.6 合成資料實跑 authority v3 備份還原 **48 項**、薪資更正 **30 項**，皆通過，無略過。這與 generic `restore:check` 的略過狀態分開記錄。
- 未驗證：完整 Supabase 平台備份政策/保留期/告警、owner/ACL、cluster globals、managed storage、跨帳戶或機器解密、完整平台災難復原。正式維護開關本輪未讀取環境值。

## 已確認問題與修復

| 問題 | 合成重現與影響 | 修復範圍 |
| --- | --- | --- |
| 掃碼保留失效員工快取 | 已成功掃描後停用、刪除或換識別碼，browser/device 兩入口原仍回 200 並寫出勤 | 移除 route 的四小時員工快取；repository AES fallback 只用快取定位ID，重新讀取現列並核對識別碼 |
| 新結算輸入驗證不足 | 負扣款 -100 原可保存，合成正常實領 31,000 變成 31,100；非法月份、JSON 與金額也可進入保存 | POST 重用既有 JSON 驗證契約，檢查年月、金額範圍及運算結果；合法負實領仍保留 |
| 結算保存混入預覽以外的出勤 | snapshot 沒有的病假仍扣500；半天預覽改以 live 全天算，另多扣250 | 新結算明確以提交的已選快照為計算範圍，檢查快照員工/月分/日期；自動月結保留既有完整出勤入口 |
| 工作假日薪資重複加計 | client total 已含1,000，server 再加1,000；合成實領32,000變33,000 | 明確區別POST的完整假日total與自動月結的base輸入，不改工資倍率或四捨五入規則 |
| 同日出勤用不同格式重複提交 | 同日病假分別用斜線/連字號日期，原會重複扣款 | 正規化日期後檢查唯一性，歧義輸入拒絕保存，不自動合併班次 |
| 月結首次並行可能撞run_key唯一鍵 | 新空PG兩個請求同時取得月份時，其中一個可能拋23505 | 僅捕捉指定run_key constraint，查回相同月份及key才安全略過，其餘錯誤仍拋出；不新增migration |
| 維運腳本未驗證外部DB憑證 | helper原固定rejectUnauthorized=false；亦強制TLS而阻擋隔離本機演練 | 外部預設驗證，僅顯式設定且已知pooler才允許例外；拒絕多host解析繞過並綁定driver目的地；loopback可本機演練 |
| 私人工作證據未明確排除 | main 的 `.jev-workflow/` 未被Git/Docker忽略，Docker亦未排除tmp等本機證據目錄 | 補Git與Docker排除；不宣稱遠端已發生私人資料外洩 |
| 一般部署/復原文件可能引導錯誤操作 | 廣泛db:push、直接還原、任意前版回退及測試旁列正式DB設定 | 導向專用preview/journal/epoch流程、隔離測試、明確SQL授權，歷史測試數不再當目前pass |

這些差額只來自去識別化合成資料，沒有掃描或推定正式受影響員工，也沒有回填正式薪資。

## 依賴安全

本輪 `npm audit --omit=dev` 在2.2.7的 Nodemailer 9.1.1 查到一個受影響套件、五項公告，最高 high；與先前「audit通過」是不同時間的結果。
[官方公告](https://github.com/advisories/GHSA-v53p-9fqp-m79j)與[10.0.13發行說明](https://github.com/nodemailer/nodemailer/releases/tag/v10.0.13)已核對。
受影響版本存在不代表已證明正式路由可利用或已洩漏。主版本升級在獨立 `codex/payroll-mail-security` 分支檢測，不混入薪資修復；不自動合併既有 Dependabot #101。
獨立分支已測 Nodemailer 10.0.13，runtime audit為0，unit796、smoke212與合成郵件transport6項通過；草稿 [PR #108](https://github.com/pcedison/salary-count-barcode-scan-public/pull/108) 尚未合併。正式SMTP認證/TLS/投遞未驗證。

## 效能基準

見 [PERFORMANCE_BASELINE_2026-10-02.md](PERFORMANCE_BASELINE_2026-10-02.md)。100、1,000、10,000筆均完成固定金額/筆數驗證。
在本機10,000筆、concurrency 1下，薪資首頁HTTP P95 10.840ms、末頁12.829ms、搜尋16.834ms；均為兩次query，未重現舊N+1報告。
已結算月份未分頁回應約620KB、P95 41.005ms，是值得後續監控的成長點，尚不足以認定正式瓶頸。本輪不為缺乏證據的效能問題改寫SQL或新增索引。

## 驗證狀態

最終完整 `verify:release`（本機16:29～16:30）：99個unit檔、879項通過；21個smoke檔、276項通過；TypeScript、Node runtime契約查核、build與runtime bundle檢查通過。
generic `restore:check` 因無備份檔而略過，不能記為還原成功；真正還原證據來自上列全新隔離PG測試。CI狀態另於本機交接紀錄列出，不能將本機通過說成CI或部署完成。
失敗重現、測試框架錯誤與修後通過分開保存；不以exit 0推定所有步驟完成。

一般real-DB測試已在新空loopback PG實跑15項（retention3、monthly8、rehearsal4），0略過。
月結包含12輪×6並行，每輪恰有1個取得執行權、5個略過，DB僅1列。初跑4項失敗中，
一項是實際run_key競態、兩項是腳本強制TLS、本機npm shim缺PATH另為測試環境問題；均分別修正再跑，未當作原本通過。
Reviewer額外確認多host會繞過TLS例外政策，修復後13項TLS邊界測試通過；這是本次修復審查抓到並修正的漏洞，沒有發布中間版本。

## 仍需核對的邊界

- 掃碼讀取員工狀態與寫入出勤不是同一交易；停用恰巧發生在查詢之後的並行競態未在本輪解決。
- AES fallback 對外部新增/更換為全新識別碼、且舊cache完全miss時，可能直到本instance失效/重啟才找得到。現在修復拒絕陳舊身分授權，不是跨instance cache同步機制。
- POST金額仍遵守現有管理員提交契約；並未新增完整的服務端預覽簽章或保存全部歷史費率版本。未證明所有舊紀錄或所有現行計薪情境均正確。
- 未執行正式滲透/壓力測試；DB TLS、最小權限、RLS、完整PDF Chromium出站邊界仍需平台證據。
- 效能尚未涵蓋正式延遲、多使用者併發、AES掃碼P95、PDF/backup同時負載、前端載入與Linux字體排版。
- 本輪無前端產品修改；先前正式desktop/mobile薪資驗收不當作本輪重新驗收。Chrome本輪只核對登入、設定頁版本、載入檔名及平台儲存。

## 持久儲存的下一個具體操作包（尚未執行）

建議為服務建立持久volume並將APP_RUNTIME_DIR及其backup/log/report子目錄對齊同一持久根目錄，另保留加密容器外副本。volume本身不等於備份。
正式變更前先取得現檔案白名單、bytes/SHA256與容器外副本、執行身份及目錄權限，再提出確切掛載位置與停機範圍；不能直接掛空volume遮住舊資料。
先在隔離容器以合成backup/log/PDF驗證掛載與容器替換後逐檔一致，再用已核准維護窗口切換、按白名單遷移、驗證權限與雜湊。
預期不改DB或薪資金額，但實際差額必須以切換前後指紋證明。未取得具體確認不掛載正式磁碟、不搬正式備份、不還原DB，也不重寄PDF。

## Jev與證據

- 調查順序receipt `03af60d1beab4cf7a167e06edc7db2be`：jev-1.13.0，input1645/output46，664ms；先測列印token再做scan，36項通過後進scan重現。分布較接近，沒有把confidence當安全保證。
- 修復形式receipt `684f40530c4c4213a2a5cdf3448d07b7`：jev-1.13.0，input2052/output43，802ms；採明確選項區分POST與automation假日total語義，與Codex原基準相同。
- 兩次均真API、非cache；來源原文/hash/byte offset與payload在送出及採用前核對。私人正式資料未進payload。原文spec、manifest、receipt、ledger保留本機忽略目錄，沒有整包發布。
- 備份/版本/算術/測試是固定事實檢查，没有為用量另外製造語意請求。
