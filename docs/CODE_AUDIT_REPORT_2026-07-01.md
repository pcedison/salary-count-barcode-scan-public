# barcode_scan_V3 專案審查報告

- **審查日期**：2026-07-01
- **審查範圍**：`server/`（Express + TypeScript + Drizzle ORM + PostgreSQL）、`client/`（React 18 + TypeScript + Vite + TailwindCSS + shadcn/ui）、`shared/`、Supabase RLS SQL
- **審查方式**：4 個獨立方向的靜態程式碼審查（效能/可靠度、安全性、模組化/可重構性、前端 UI/UX），涵蓋近期 `Harden monthly salary run RLS` commit 的變更
- **審查基準**：唯讀審查，未修改任何程式碼

## 總體評分

| 面向 | 評分 (1-10) |
|---|---|
| 效能 (Performance) | 7 |
| 可靠度 (Reliability) | 7 |
| 安全性 (Security) | 8 |
| 模組化 (Modularity) | 5 |
| 可重構性 (Refactorability) | 5 |
| 前端 UI/UX — Web | 8 |
| 前端 UI/UX — Mobile | 7.5 |
| **整體平均** | **7.1** |

**一句話總結**：這是一個安全性紮實、前端體驗優於一般水準的專案，主要短板集中在後端「模組化程度」（`storage.ts` God Object）與少數併發控制缺口（月薪自動化的 race condition）。

---

## 1. 效能（7/10）

### 問題
| 嚴重度 | 位置 | 問題 |
|---|---|---|
| Medium | `server/services/monthlySalaryAutomation.ts:298-346` | 對每位在職員工序列執行 3+ 次 DB round-trip（N+1），無 `Promise.all` 批次化，員工數增加時耗時線性放大 |
| Medium | `server/routes/salary.routes.ts:271-278` | `/api/salary-records/print-batch` 逐一 `await getSalaryRecordById(id)`，應改用 `inArray` 一次查詢 |
| Low | `server/storage.ts:447-460` | `getTemporaryAttendanceByEmployeeAndMonth` 用雙 `LIKE` 條件配合 `employeeId`，但只有單欄索引，無 `(employeeId, date)` 複合索引 |
| 已知技術債 | `server/repositories/employeeRepository.ts:152-183` | `getEmployeeByIdNumber` fallback 因加密 nonce 不同需全表掃描解密，已有註解說明並用快取緩解，非新問題 |

### 做得好的地方
- `/api/salary-records`、`/api/attendance` 主列表均已分頁
- `calculationRulesLoader.ts` 記憶體快取計薪規則、可熱重載
- `employeeRepository.ts` 的 `identityLookupCache` 與 `inArray` 批次查詢設計良好
- `/api/health` 有短 TTL 結果快取，避免健康檢查造成額外 DB 負載
- LINE API 呼叫使用 `AbortController` 逾時並平行呼叫

---

## 2. 可靠度（7/10）

### 問題（含本次 RLS commit 相關的併發風險）
| 嚴重度 | 位置 | 問題 |
|---|---|---|
| **High** | `server/services/monthlySalaryAutomation.ts:210-253` (`acquireRun`) | 「讀取 → 判斷 → 更新/建立」非原子流程，未用 `SELECT ... FOR UPDATE` 或條件式 upsert。手動觸發端點與排程 tick 走不同路徑，排程的 `running` 旗標只在單一 process 記憶體生效，多實例部署下無法防止併發跑批，可能重複寄送薪資 email / 產生重複 PDF |
| **High** | `server/services/monthlySalaryAutomation.ts:278` vs 292 | `acquireRun` 呼叫在 try/catch 範圍**之外**，若因上述 race 觸發 unique constraint violation，會以未處理例外拋出，該筆 run 記錄不會被標記為 `failed` |
| Medium | `server/services/monthlySalaryAutomation.ts:292-346` | 每員工計算＋寫入迴圈**沒有包在 DB transaction 內**，中途失敗會留下半套薪資資料，且重跑時可能被誤判為「已存在」而跳過 |
| Medium | 全專案 | 沒有全域 `unhandledRejection`/`uncaughtException` handler，未預期的 Promise rejection 不會觸發可控退出或告警 |
| Low | `server/services/line.service.ts` | LINE API 呼叫有逾時但無重試機制，短暫網路抖動會直接失敗 |
| Low | 測試 | 缺少針對 `acquireRun` 併發/race condition 的測試 |

### 做得好的地方
- `employeeRepository.ts` 的 `purgeEmployee`、`encryptAllPlaintextEmployees`、`trashEmployee` 均正確使用 `db.transaction`
- 出勤打卡（`upsertTemporaryAttendanceScan`）在 transaction 內用 `pg_advisory_xact_lock` 防止同員工併發打卡競態，是很扎實的做法
- `db-monitoring.ts` 的還原流程對可重試 DB 錯誤碼做指數退避重試
- `graceful-shutdown.ts` 實作完整（SIGTERM/SIGINT、逾時強制退出、依序關閉）
- `/api/health`、`/ready`、`/live` 三層探針齊全
- LINE webhook 過濾過期事件、簽章驗證失敗立即拒絕且回 200 避免重試風暴
- server 端測試覆蓋率高（53 test 檔 / 68 source 檔），含大量 integration test，是重構安全網

**建議優先修復**：把 `acquireRun` 改為單一原子 SQL（`INSERT ... ON CONFLICT DO UPDATE ... WHERE status != 'running' RETURNING *`），並將呼叫移入 try/catch 妥善處理 unique-violation。

---

## 3. 安全性（8/10）

未發現 Critical / High 等級漏洞。本次「Harden monthly salary run RLS」commit 邏輯正確：三份 SQL 檔案（`supabase_schema.sql`、`updated_supabase_schema.sql`、`supabase_public_api_hardening.sql`）與 `scripts/harden-supabase-public-schema.mjs` 都同步加入 `monthly_salary_runs`，採「無 policy = 全阻擋 + REVOKE ALL」策略，不存在單一操作被遺漏的問題。

### 問題
| 嚴重度 | 位置 | 問題 |
|---|---|---|
| Medium | `server/admin-auth.ts:113-115` | 非 production 環境若 `SUPER_ADMIN_PIN` 未設定，`verifySuperAdminPermission` 會退化用一般 admin PIN 核准 SUPER 提權；若 staging 誤設 `NODE_ENV=development`，一般 PIN 即可提權。建議 fallback 僅限 `test` 環境 |
| Medium | `supabase_public_api_hardening.sql:12` | 含 `'users'` 表，但 `supabase_schema.sql`/`updated_supabase_schema.sql` 對應清單未列出，三份檔案有配置漂移（目前專案 schema 無此表，實際風險低） |
| Low | `server/middleware/security.ts:112-137` | CSRF 防護僅靠 SameSite cookie + Origin 檢查，無顯式 CSRF token，屬架構取捨而非漏洞 |
| Low | `server/session.ts:88-98` | `SESSION_SECURE` 環境變數可手動覆蓋關閉 secure cookie，建議 production + `SESSION_SECURE=false` 時顯式警告或拒絕啟動 |
| Low | `raspi-barcode-scanner.py:145` | `os.system('clear')` 為硬編碼字串無注入風險，但屬舊式寫法 |

### 做得好的安全措施
- Admin 認證：PBKDF2-SHA512、600,000 迭代、per-hash 隨機鹽、自動升級舊迭代次數
- Session cookie：httpOnly 預設開、sameSite 預設 strict、secure 依 production 自動開啟、session secret 強制 ≥32 字元
- SUPER 提權明確拒絕 production 明文 PIN
- LINE Webhook 用 timing-safe HMAC 驗證 + 過期事件過濾
- Scan device token / unlock token 皆用 `crypto.timingSafeEqual`，並有 nonce 防重放
- 全面使用 Drizzle 參數化查詢，僅有的 `sql.raw()` 用硬編碼表名，非使用者輸入
- 敏感欄位（如 adminPin）有明確 allowlist 過濾，永不出現在任何 API 回應
- Log 只擷取白名單欄位，不會把 request body 全文寫入日誌
- Rate limiting 覆蓋登入、掃描、LINE 綁定/打卡等所有敏感端點

---

## 4. 模組化與可重構性（各 5/10）

### 問題
| 位置 | 問題 |
|---|---|
| `server/storage.ts`（1053行） | God Object：單一 `DatabaseStorage` class 承擔 employees、attendance、settings、salary records、monthly salary runs、holidays、LINE bindings 等十幾個領域的資料存取。真正拆出的 `employeeRepository.ts` 只被 `storage.ts` 內部引用，route 層仍統一呼叫 `storage.xxx()`，造成「看起來分層、實際上還是單體」 |
| `server/routes/scan.routes.ts`（647行） | 路由檔案內直接實作 HMAC token 簽章/驗證、記憶體快取、nonce 防重放，應屬 service 層職責；第 555-565 行與 617-627 行有近乎逐行複製的 dedup 清理邏輯 |
| `client/src/hooks/useAttendanceData.ts`（766行） | 單一 hook 同時處理 attendance/salary 查詢、特休試算、同步狀態、mutation，難以單元測試 |
| `client/src/pages/AttendancePage.tsx`（786行）、`HistoryPage.tsx`（679行） | 頁面混雜資料抓取、格式化、UI 渲染，超過 500 行門檻 |
| client 端型別把關 | `: any`/`as any` 共 35 處，集中在 `HistoryTable.tsx`、`EditHistoryRecordModal.tsx`、`useAttendanceData.ts`（server 端僅 5 處，明顯較嚴謹） |
| API 呼叫模式 | `queryClient.ts` 已有統一 `apiRequest()`，但 `useBarcodeScanner.ts`（5 處）、`ClockInPage.tsx`（3 處）仍用裸 `fetch()` 重複寫 header/credentials 邏輯 |
| 測試覆蓋不對稱 | client 僅 10 個 test 檔對 105 個 source 檔（~9.5%），components/pages/hooks（含 766 行的 `useAttendanceData`）完全無測試覆蓋，重構風險高 |

### 做得好的地方
- `shared/schema.ts` 用 Drizzle table + `drizzle-zod` 建立單一事實來源，client/server 共用型別且無循環依賴
- middleware（`rateLimiter.ts`、`requireAdmin.ts`、`security.ts`）、config（`envValidator.ts`、`databaseUrl.ts`）拆分清楚
- `route-helpers.ts`、`scan-helpers.ts`、`salary-helpers.ts` 顯示團隊已有意識地抽出純函式，只是抽得不夠徹底
- server 端 integration test 覆蓋率高，是重構 server 的可靠安全網

**建議優先順序**：
1. 把 `storage.ts` 拆成 per-domain repository（employee/attendance/salary/holiday/line），routes 直接依賴對應 repository
2. 把 `useAttendanceData.ts` 拆成多個小 hook
3. 補齊 client 端 component/hook 測試，再進行 UI 重構

---

## 5. 前端 UI/UX（Web 8/10、Mobile 7.5/10）

### 問題
| 位置 | 問題 |
|---|---|
| `client/src/components/ui/button.tsx:23-27` | `sm`(36px)/`default`(40px)/`icon`(40×40px) 均低於 44×44px 觸控慣例，手機卡片操作按鈕多用 `size="sm"`，誤觸風險高 |
| `client/src/components/AttendanceTable.tsx:206` | 用原生 `window.confirm()` 刪除考勤紀錄，與系統其他地方統一使用的 `ConfirmationModal` 不一致，手機瀏覽器/PWA 中樣式突兀 |
| `HistoryTable.tsx:162-197`、`EmployeesTableCard.tsx:180-217` | 圖示式操作按鈕僅靠 `title`，缺少 `aria-label`，觸控裝置無 hover、螢幕閱讀器支援不可靠 |
| `AttendancePage.tsx:507,738`、`HistoryPage.tsx:478,587,600,617` | 混用 `lucide-react` 與 Google Material Icons ligature 字型，字型載入失敗會直接顯示英文字，視覺風格也不統一 |
| `index.css:102`（`--ink-3: #8e948e`） | 用於手機底部導覽文字（11px）、footer 等處，與背景對比接近或低於 WCAG AA 4.5:1 門檻 |

### 做得好的設計
- `AttendanceTable.tsx`、`HistoryTable.tsx`、`EmployeesTableCard.tsx` 都採用 `md:hidden` 卡片 + `hidden md:block` 表格的標準響應式模式，避免表格硬擠手機的常見問題
- `AppShell` 手機底部 Tab Bar（含 `env(safe-area-inset-bottom)` 安全區處理）+ 桌機可收合側邊欄，分情境設計
- 條碼掃描頁流程精簡：單一輸入框、自動 focus、Enter 送出、6 秒自動清除的成功/失敗回饋，適合高頻 kiosk 操作
- 全站以 toast + destructive variant 統一呈現錯誤，loading 狀態一致
- shadcn/ui 元件庫覆蓋完整（40+ 元件），各頁面重用度高

### 可執行優化建議
1. 將 `Button` 的 `sm`/`icon` 尺寸在行動裝置情境提升到至少 44px（可加 `size="mobile"` 變體），優先套用在 HistoryTable、EmployeesTableCard 手機卡片操作按鈕
2. 把 `AttendanceTable.tsx:206` 的 `window.confirm` 換成既有的 `ConfirmationModal`
3. 為所有 icon-only 按鈕加上 `aria-label`
4. 統一圖示系統，將剩餘 `material-icons` 用法改為 `lucide-react`
5. 複查 `--ink-3` 在淺色背景小字的對比度，必要處改用更深的 `--ink-2`

---

## 綜合建議優先順序

1. **修 `acquireRun` 併發控制**（可靠度 High）— 改為原子 SQL 條件式 upsert，並補上 try/catch 處理 unique-violation，避免月薪自動化重複跑批
2. **拆分 `server/storage.ts`**（模組化）— 這是後端最大的技術債，影響往後所有新功能的開發成本
3. **前端小幅 UI 修正**（UI/UX）— 觸控目標尺寸、`window.confirm` 替換、`aria-label` 補齊，成本低、對手機版體驗提升明顯
4. **補齊 client 端測試**（可重構性）— 尤其是 `useAttendanceData.ts` 這類大型 hook，先有安全網再重構
5. **`server/admin-auth.ts` SUPER 提權 fallback 收斂到 `test` 環境**（安全性 Medium）— 防止 staging 誤設環境變數造成的提權風險

---

*本報告由 4 個獨立審查 agent（效能/可靠度、安全性、模組化/可重構性、前端 UI/UX）平行掃描產生，審查對象為 `codex/fix-monthly-salary-runs-rls` 分支當前狀態。*
