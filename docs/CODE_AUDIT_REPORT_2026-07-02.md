# barcode_scan_V3 專案掃描審視報告

- **審查日期**：2026-07-02
- **審查分支**：`codex/fix-monthly-salary-runs-rls`
- **審查範圍**：`server/`（Express + TypeScript + Drizzle ORM + PostgreSQL/Supabase）、`client/`（React 18 + Vite + TailwindCSS + shadcn/ui）、`shared/`、部署與 SQL 硬化腳本
- **審查方式**：靜態程式碼掃描 + 對 2026-07-01 審計報告各項發現逐一重新驗證
- **審查基準**：唯讀審查，未修改任何程式碼

## 重要前提：與 7/1 報告的關係

專案內已存在 `CODE_AUDIT_REPORT_2026-07-01.md` 與三份修復計畫（race condition、storage 拆分、mobile UI polish）。本次逐一重新驗證後確認：**三份計畫均已撰寫完成，但程式碼尚未實作，所有已知問題仍然存在**。因此本報告的重點是：(1) 確認舊發現的現況、(2) 補充獨立掃描的新觀察、(3) 更新評分。

## 總體評分

| 面向 | 本次評分 (1-10) | 7/1 評分 | 變化說明 |
|---|---|---|---|
| 效能 (Performance) | 7 | 7 | 未變，N+1 問題仍在，但基礎設計良好 |
| 可靠度 (Reliability) | 6.5 | 7 | 微降：High 級 race condition 已知超過一天仍未修復，且無全域例外處理 |
| 安全性 (Security) | 8 | 8 | 未變，無 Critical/High 漏洞 |
| 模組化 (Modularity) | 5 | 5 | 未變，`storage.ts` God Object 仍在 |
| 可重構性 (Refactorability) | 5.5 | 5 | 微升：三份設計文件與計畫已就緒，重構路徑明確 |
| 前端 UI/UX — Web（閱讀性/操作） | 8 | 8 | 未變 |
| 前端 UI/UX — Mobile（閱讀性/操作） | 7 | 7.5 | 微降：觸控尺寸、對比度、`window.confirm` 均已有修復計畫但未執行 |
| **整體平均** | **6.7** | 7.1 | |

**一句話總結**：安全性紮實、前端架構優於一般水準的中型全端專案；最大風險是「已知的 High 級併發缺陷（月薪自動化重複跑批）遲未修復」，最大技術債是後端 `storage.ts` 單體資料層與 client 端測試覆蓋不足。

---

## 1. 效能（7/10）

### 問題（本次已重新驗證仍存在）

| 嚴重度 | 位置 | 問題 |
|---|---|---|
| Medium | `server/services/monthlySalaryAutomation.ts:299-346` | 對每位在職員工序列執行 3+ 次 DB round-trip（`getSalaryRecordByYearMonthEmployee` → `getTemporaryAttendanceByEmployeeAndMonth` → 寫入），N+1 模式，員工數增加時跑批耗時線性放大 |
| Medium | `server/routes/salary.routes.ts:271-278` | `/api/salary-records/print-batch` 在 for 迴圈內逐一 `await storage.getSalaryRecordById(id)`，應改為 `inArray` 單次查詢 |
| Low | `server/storage.ts` | `getTemporaryAttendanceByEmployeeAndMonth` 用雙 `LIKE` 查月份，缺 `(employeeId, date)` 複合索引 |
| 已知技術債 | `server/repositories/employeeRepository.ts` | 加密欄位 fallback 全表掃描解密，已有註解與快取緩解 |

### 做得好的地方

- **前端 code splitting 完整**：`App.tsx` 所有頁面均 `React.lazy` 動態載入，並配合 `registerMainTabPreloader` 做主分頁預載，是同規模專案少見的細緻做法
- 主列表 API（salary-records、attendance）均已分頁
- `calculationRulesLoader.ts` 記憶體快取計薪規則、可熱重載
- `employeeRepository.ts` 的 `identityLookupCache` 與 `inArray` 批次查詢
- `/api/health` 有短 TTL 快取；LINE API 呼叫用 `AbortController` 逾時 + 平行呼叫
- CSV import 路由獨立 5mb body limit，一般 API 限 512kb，避免大 payload 拖垮記憶體

---

## 2. 可靠度（6.5/10）

### 問題

| 嚴重度 | 位置 | 問題 | 現況 |
|---|---|---|---|
| **High** | `monthlySalaryAutomation.ts:210-253`（`acquireRun`） | 「讀取 → 判斷 → 更新/建立」非原子操作，多實例或排程與手動觸發並發時可能重複跑批、重複寄送薪資 email。排程的 in-memory `running` 旗標無法跨 process 生效 | **未修復**（計畫 `2026-07-01-monthly-salary-run-race-condition-fix.md` 已寫好） |
| **High** | 同檔 `:278` | `acquireRun` 呼叫位於 try/catch **之外**，race 觸發 unique violation 時例外未處理，run 記錄不會被標記 `failed` | **未修復** |
| Medium | 同檔 `:292-346` | 每員工計算＋寫入迴圈無 DB transaction 包覆，中途失敗留下半套薪資資料 | **未修復** |
| Medium | 全專案 | 無 `process.on('unhandledRejection')` / `uncaughtException` handler（本次以全 server 目錄 grep 確認為 0 處） | **未修復** |
| Low | `line.service.ts` | LINE API 有逾時無重試 | 未修復 |

### 做得好的地方

- 出勤打卡 `upsertTemporaryAttendanceScan` 在 transaction 內使用 `pg_advisory_xact_lock`，同員工併發打卡防護紮實 —— **諷刺的是同一個 codebase 已示範過正確做法，月薪跑批卻沒沿用**
- `graceful-shutdown.ts` 完整（SIGTERM/SIGINT、逾時強制退出、依序關閉）
- `/api/health`、`/ready`、`/live` 三層探針齊全
- Express 全域錯誤 handler（`create-app.ts:80-94`）production 下遮蔽 5xx 詳細訊息，避免資訊洩漏
- server 端測試 53 個 test 檔對 68 個 source 檔（~78%），含大量 integration test

---

## 3. 安全性（8/10）

未發現 Critical / High 等級漏洞。RLS 硬化（`monthly_salary_runs` 無 policy 全阻擋 + REVOKE ALL）三份 SQL 檔案與硬化腳本一致。

### 問題

| 嚴重度 | 位置 | 問題 |
|---|---|---|
| Medium | `server/admin-auth.ts:113-115` | 非 production 環境若 `SUPER_ADMIN_PIN` 未設定，退化用一般 admin PIN 核准 SUPER 提權（本次重新驗證仍存在）。若 staging 誤設 `NODE_ENV=development`，一般 PIN 即可提權。建議 fallback 收斂到僅 `test` 環境 |
| Medium | SQL 硬化檔案 | `supabase_public_api_hardening.sql` 的表清單含 `users`，與另兩份 schema 檔清單有配置漂移（實際 schema 無此表，風險低但應同步） |
| Low | `server/middleware/security.ts` | CSRF 防護靠 SameSite cookie + Origin 檢查，無顯式 token（架構取捨） |
| Low | `server/session.ts` | `SESSION_SECURE=false` 可在 production 手動關閉 secure cookie，建議顯式警告或拒絕啟動 |
| Low | `salary.routes.ts:260` | `/api/salary-records/print-batch` 不走 `requireAdmin`，僅靠 `verifySalaryPrintToken`——token 為 HMAC 短效簽章設計上可接受，但屬於需持續留意的信任邊界 |

### 做得好的安全措施

- PBKDF2-SHA512、600,000 迭代、per-hash 隨機鹽、舊迭代自動升級
- Session：httpOnly、sameSite strict、secret 強制 ≥32 字元
- production 明確拒絕明文 `SUPER_ADMIN_PIN`
- LINE Webhook timing-safe HMAC + 過期事件過濾；raw body 專用路由確保簽章可驗（`create-app.ts:60`）
- Scan device token / unlock token 用 `crypto.timingSafeEqual` + nonce 防重放
- 全面 Drizzle 參數化查詢；`sql.raw()` 僅用於硬編碼表名
- 敏感欄位 allowlist 過濾；log 僅擷取白名單欄位
- Rate limiting 覆蓋所有敏感端點，且 `/api` 全域套用 `publicApiLimiter`

---

## 4. 模組化（5/10）與可重構性（5.5/10）

### 問題（本次重新驗證）

| 位置 | 問題 | 現況 |
|---|---|---|
| `server/storage.ts`（1,053 行） | God Object：單一 class 承擔 employees、attendance、settings、salary、monthly runs、holidays、LINE bindings 等十餘領域。`employeeRepository.ts` 已拆出但只被 `storage.ts` 內部代理，routes 仍統一呼叫 `storage.xxx()` | **未拆分**（計畫 `2026-07-01-storage-repository-split.md` 已寫好） |
| `server/routes/scan.routes.ts` | 路由檔內含 HMAC 簽章、記憶體快取、nonce 防重放等 service 層職責，且有兩段近乎複製的 dedup 清理邏輯 | 未重構 |
| `client/src/hooks/useAttendanceData.ts`（766 行） | 單一 hook 混合查詢、試算、同步狀態、mutation | 未拆分 |
| `AttendancePage.tsx`（786 行）、`HistoryPage.tsx`（679 行） | 頁面混雜資料抓取、格式化、渲染 | 未拆分 |
| client 型別把關 | `: any` / `as any` 35 處、12 個檔案（本次重新計數確認），集中在 `HistoryTable.tsx`(7)、`useAttendanceData.ts`(9)、`EditHistoryRecordModal.tsx`(5)；server 端明顯較嚴謹 | 未改善 |
| API 呼叫模式 | 裸 `fetch()` 17 處、8 個檔案（`useBarcodeScanner.ts` 5 處、`ClockInPage.tsx` 3 處…），未統一走 `queryClient.ts` 的 `apiRequest()` | 未改善 |
| 測試不對稱 | client 10 test 檔 / 105 source 檔（~9.5%）vs server 53/68（~78%）。components、pages、hooks 幾乎零覆蓋 | 未改善 |

### 做得好的地方

- `shared/schema.ts` 以 Drizzle + `drizzle-zod` 做單一事實來源，client/server 共用型別
- `bootstrap/create-app.ts` 把 app 組裝抽成純函式，middleware 順序（trust proxy → security → session → rate limit → body parser → logging）正確且可測試
- middleware、config、route-helpers 拆分清楚；全專案 `TODO/FIXME` 為 0，沒有「掃到一半的爛尾」
- **可重構性微升的原因**：三份設計 spec + 實作計畫已就緒（`docs/superpowers/plans/`），server 端 integration test 是可靠安全網，拆分 `storage.ts` 的執行風險已大幅降低——欠缺的只是執行

---

## 5. 前端 UI/UX（Web 8/10、Mobile 7/10）

### 問題（本次重新驗證仍存在）

| 位置 | 問題 |
|---|---|
| `client/src/components/ui/button.tsx:22-27` | `sm`(36px)/`default`(40px)/`icon`(40×40px) 低於 44×44px 行動觸控慣例；手機卡片操作多用 `size="sm"`，誤觸風險高 |
| `AttendanceTable.tsx` | 原生 `window.confirm()` 刪除確認，與全站 `ConfirmationModal` 不一致，PWA/手機瀏覽器樣式突兀 |
| `HistoryTable.tsx`、`EmployeesTableCard.tsx` | icon-only 按鈕僅有 `title` 無 `aria-label`，觸控裝置與螢幕閱讀器支援不可靠 |
| `AttendancePage.tsx`、`HistoryPage.tsx`、`SettingsPage.tsx`、`SalaryResultTable.tsx` | 混用 `lucide-react` 與 Google Material Icons ligature 字型（本次 grep 確認 5 檔仍在用），字型載入失敗會直接顯示英文字 |
| `index.css`（`--ink-3`） | 用於手機底部導覽 11px 小字，對比接近或低於 WCAG AA 4.5:1 |

### 做得好的設計（閱讀性/操作性亮點）

- 三大資料表均採 `md:hidden` 卡片 + `hidden md:block` 表格的響應式雙版型，手機閱讀性良好
- `AppShell`：手機底部 Tab Bar（含 `env(safe-area-inset-bottom)`）+ 桌機可收合側邊欄
- 條碼掃描頁 kiosk 化流程：自動 focus、Enter 送出、6 秒自動清除回饋
- 全站 toast + destructive variant 統一錯誤呈現；lazy 頁面有一致的 `LoadingFallback`
- shadcn/ui 40+ 元件覆蓋，重用度高

### 優化建議（成本低、收益明顯，計畫已在 `2026-07-01-mobile-ui-polish.md`）

1. `Button` 增加行動觸控尺寸變體（≥44px），優先套用手機卡片操作按鈕
2. `window.confirm` → 既有 `ConfirmationModal`
3. icon-only 按鈕補 `aria-label`
4. 統一圖示系統為 `lucide-react`
5. 複查 `--ink-3` 小字對比，必要處改 `--ink-2`

---

## 綜合建議優先順序

前次報告的建議完全成立且尚未執行，本次維持同樣排序並強調急迫性：

1. **【立即】執行 race condition 修復計畫**（可靠度 High）— 計畫已寫好（`docs/superpowers/plans/2026-07-01-monthly-salary-run-race-condition-fix.md`），改為原子 SQL 條件式 upsert + try/catch 處理 unique violation。這是唯一可能造成「重複寄送薪資 email」實際業務事故的缺陷，每延後一個月結週期就多一次風險曝露
2. **【短期】執行 mobile UI polish 計畫** — 五項修正成本極低，對手機版體驗與無障礙提升立竿見影
3. **【中期】執行 storage.ts 拆分計畫** — server 測試安全網已足夠，拆分風險可控；這是後端所有新功能開發成本的根源
4. **【中期】收斂 `admin-auth.ts` SUPER 提權 fallback 至 `test` 環境**（安全 Medium）
5. **【持續】補齊 client 端測試**（現況 9.5%）— 至少先覆蓋 `useAttendanceData.ts` 與薪資計算相關 components，再做 UI 重構
6. **【小改】`print-batch` N+1 改 `inArray`、加 `unhandledRejection` 全域 handler** — 各半天內可完成

---

*本報告由 Claude（Fable 5）於 2026-07-02 以靜態掃描 + 對前次審計逐項重新驗證產生。專案內另有三份已就緒但未執行的修復計畫，位於 `docs/superpowers/plans/`。*
