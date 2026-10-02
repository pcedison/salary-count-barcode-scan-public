# Nodemailer 主版本安全更新驗證 — 候選 2.2.8（2026-10-02）

## 結論

將直接執行期相依 Nodemailer 從 9.1.1 升級至 10.0.13；`package.json`
使用 `^10.0.13`，lockfile 鎖定 10.0.13。原版 audit 列出一個高風險受影響
套件、五則 advisories；更新分支的 `npm audit --omit=dev` 為 0。
這只代表本次查詢未發現已知相依漏洞，不能宣稱整個系統沒有安全問題。

變更在獨立 `codex/payroll-mail-security` 分支，基底
`342b49c34f6749e811faf530fe65683c46b31f43`。本文件記錄本機驗證，
不代表已 commit、push、開 PR、通過 GitHub CI 或部署正式站。
正式站未因這些測試而寄信、修改薪資或重算資料。

## 已確認問題與尚未證明的事

已確認原版套件落在以下公告的受影響範圍：

| 公告 | 類型 |
| --- | --- |
| [GHSA-6vj9-mwq6-2f5v](https://github.com/advisories/GHSA-6vj9-mwq6-2f5v) | DNS cache 與 TLS servername 跨 transport 混用 |
| [GHSA-8vvx-rff5-p5rq](https://github.com/advisories/GHSA-8vvx-rff5-p5rq) | 巢狀收件者陣列的堆疊耗盡 |
| [GHSA-g57g-f23g-4646](https://github.com/advisories/GHSA-g57g-f23g-4646) | quoted local-part／comment 位址解析錯誤 |
| [GHSA-v53p-9fqp-m79j](https://github.com/advisories/GHSA-v53p-9fqp-m79j) | 位址 free-text fallback 的正規表示式回溯 |
| [GHSA-prgh-xp8r-p3m5](https://github.com/advisories/GHSA-prgh-xp8r-p3m5) | comment-joined addresses 的平方級成本 |

本輪沒有證明正式站可被外部攻擊者利用上述路徑，也沒有向正式 SMTP 或正式站
投送攻擊內容。「受影響套件存在」與「正式環境可利用」須分開判斷。

## 相容性核對

[10.0.0 官方發布說明](https://github.com/nodemailer/nodemailer/releases/tag/v10.0.0)
要求 Node.js 20 以上，改用 ESM/CJS 發布並保留 `@types/nodemailer` 的相容布局。
本專案 Node 24.16.0 符合，現有 `@types/nodemailer` 不變，TypeScript 檢查通過。
[10.0.13 官方發布說明](https://github.com/nodemailer/nodemailer/releases/tag/v10.0.13)
列出 SASL 方法解析及 angle-addr comment 處理修正。

`server/services/salaryEmail.ts` 的 `await import('nodemailer')` 與
`nodemailer.createTransport(...)` 實際在測試中執行，沒有 mock Nodemailer。
另外用原生 Node ESM import 確認 `createTransport` 可取得；production build 通過，
無需改動產品郵件呼叫 API。

## 合成 SMTP／MIME 驗證

新增 `server/services/salaryEmail.transport.test.ts` 共 6 項：

1. 真實 Nodemailer stream transport 產生中文主旨／本文 MIME，完全不開網路。
2. 真實應用月結郵件送到只監聽 `127.0.0.1` 的臨時 SMTP 捕捉器；驗證中文
   寄件者、主旨、PDF 檔名、`application/pdf`、附件原始 bytes、2 筆合成薪資
   的 60,000 元合計，以及精確兩個 envelope 收件者。
3. 真實測試郵件路徑的指定收件者、繁中本文及 Asia/Taipei 時間。
4. 本機 SMTP 回覆 550 拒絕收件者時，應用收到 `EENVELOPE`，不回報寄送成功。
5. 不存在的 PDF 經真實 transport 回傳 `ESTREAM`，沒有完整 SMTP 郵件。
6. 缺少明確設定時，在建立 SMTP 連線前拒絕。

SMTP 捕捉器只保存本程序內的合成訊息，沒有 relay 能力；所有收件者使用
`example.test`，所有設定由測試明確傳入，未讀取 `.env` 或正式 SMTP 設定。
這些測試沒有真正寄送郵件。stream transport 的用法依
[Nodemailer 官方文件](https://nodemailer.com/transports/stream)。

初跑有兩個測試斷言失敗：Node ICU 日期使用 thin space，以及 Nodemailer 將
附件讀取錯誤分類為 `ESTREAM`。已依實際傳輸契約修正斷言後重跑；沒有把
先前失敗列為產品缺陷，也沒有略過失敗測試。

## 本機驗證狀態

| 項目 | 結果 |
| --- | --- |
| `npm ci --ignore-scripts` | 通過；依 lockfile 重新安裝 468 packages，沒有執行依賴安裝 scripts |
| `npm run check` | 通過 |
| `npm test` | 796 passed、0 failed、0 pending，包含新增 6 項 transport 測試 |
| `npm run test:smoke` | 212 passed、0 failed、0 pending |
| `npm run build` | 通過，含 production runtime bundle 驗證 |
| `npm run runtime:update:audit` | 通過，Node／npm／Docker／CI runtime contract 無發現 |
| `npm audit --omit=dev` | 0 已知 vulnerabilities |
| 重裝後 6 項 transport 測試 | 6 passed、0 failed、0 pending |
| `git diff --check` | 通過 |
| 一般 `npm run restore:check` | **略過**：沒有明確 DATABASE_URL，不能列為還原通過 |

此分支未重跑實際 PostgreSQL 還原、Docker/Linux mail transport 或正式 SMTP。
真實外部郵件伺服器的認證、TLS、投遞、退信與郵件用戶端呈現仍未驗證。
這次變更沒有 UI 修改，未為此相依更新重做正式 desktop/mobile 驗收。

## 發布與回復

主版本安全更新依 `docs/DEPENDENCY_UPDATE_POLICY.md` 維持獨立人工審核，
不可使用 minor/patch auto-merge。正式發布前仍需 PR、受保護的 GitHub checks、
有提供時的 staging 相容性驗收、明確發布授權及平台部署確認。

回復應用相依版本不會回復薪資資料，亦不需要資料 migration；但回到 9.1.1
會重新引入這些已知受影響套件條件。若有實際相容性問題，先停止擴大發布，
保留合成錯誤證據再決定處置，不能用自動重寄正式薪資郵件驗證修復。

原始本機證據在 ignored `tmp/mail-security/`：unit/smoke/transport JSON、
audit JSON、check/build/runtime/restore/npm-ci logs。文件不附正式薪資、
員工資料、SMTP 憑證或實際郵件內容。
