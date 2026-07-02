# barcode_scan_V3 技術債盤點與深度專項掃描報告

- **掃描日期**：2026-07-02
- **分支**：`codex/fix-monthly-salary-runs-rls`（含當日剛完成的 race condition 修復）
- **掃描工具**：jscpd（重複程式碼）、knip（死碼/未使用依賴）、npm audit / npm outdated（依賴健康）、ripgrep 靜態掃描（型別債/API 模式）
- **驗證方式**：工具產出的高價值宣告均以人工 grep 交叉驗證，誤報已剔除或標註

## 總覽：技術債健康度

| 類別 | 狀態 | 摘要 |
|---|---|---|
| 已知漏洞 | 🟢 優 | `npm audit`：**0 個漏洞** |
| 重複程式碼 | 🟡 中 | 整體重複率 1.7%（健康），但**薪資計算邏輯存在三份拷貝**（High） |
| 死碼 | 🟡 中 | 34 個未使用檔案、28 個未使用依賴、多個未使用 export |
| 依賴時效 | 🟢 良 | 多數僅落後 minor/patch；少數 major 落後屬刻意鎖定 |
| 型別債 | 🟡 中 | client 端 `any` 35 處；server 端僅 5 處 |
| 結構債 | 🔴 待處理 | `storage.ts` God Object（1,053 行）、client 測試覆蓋 9.5% |
| TODO/FIXME 殘留 | 🟢 優 | 全專案 0 處 |

---

## 1. 重複程式碼掃描（jscpd，min-tokens 60，排除測試與 components/ui）

整體：133 檔案、28,968 行，找到 **26 個 clone**，重複率 1.70%（一般專案 5% 以下即屬健康）。但其中有結構性問題：

### 🔴 High：薪資計算邏輯三份拷貝（最重要的技術債）

以下三個檔案間有多段 30-47 行的大型 clone：

| 檔案 | 角色 |
|---|---|
| `shared/calculationModel.ts`（428 行） | 名義上的「單一事實來源」，server/client 皆有 import |
| `server/utils/salaryCalculator.ts` | server 計薪主力（`salary.routes.ts` 使用），與 shared 版有 2 段大 clone |
| `client/src/lib/salaryCalculations.ts` | client 端試算/列印用，與 server 版有 **4 段大 clone**（62-196 行區間幾乎整段相同） |

**風險**：三份拷貝已各自演化（並非單純複製，行號與細節已漂移）。任何計薪規則修改（如加班費率、假日邏輯）需要同步改三處，漏改任何一處就會出現「畫面試算 ≠ 實發薪資」的業務事故，且測試各自獨立無法互相把關。

**建議**：以 `shared/calculationModel.ts` 為唯一實作，server/client 各自只保留薄薄的 adapter（格式轉換、I/O），把三份共有的純函式（加班計算、假日加給、扣款彙總）全部上收到 `shared/`。此工作應排在 `storage.ts` 拆分之前或並行，因為它是唯一直接影響金額正確性的重複。

### 🟡 Medium：helper 已抽出但未被使用，程式碼反而被複製

- `server/routes/scan-helpers.ts` 的 `getAttendanceEventTime`（90-105 行）與 `compareAttendanceByLatestEvent`（107-127 行）在 `server/storage.ts:64-101` 有**逐字拷貝**。knip 同時將這兩個 export 標為未使用——即 helper 存在、有 export，但 `storage.ts` 選擇複製而非 import。修法：storage.ts 改 import，刪除拷貝。

### 🟡 其餘 server 端 clone（低風險、可逐步清理）

| 位置 | 說明 |
|---|---|
| `routes/scan.routes.ts:539-553` vs `603-615` | 掃描 dedup 清理邏輯重複（7/1 報告已指出） |
| `routes/attendance.routes.ts:19-42` vs `routes/salary.routes.ts:28-51` | 相同的請求前置處理區塊 |
| `dashboard-routes.ts:131-159` vs `253-281` | 儀表板統計查詢重複 |
| `routes/line/auth.routes.ts:58-69` vs `105-116` | LINE 授權流程重複 |
| `routes/employees.routes.ts`、`routes/import.routes.ts`、`routes/calculationRules.routes.ts` | 各有一組小型內部重複 |
| `scripts/restore-check.ts` vs `restore-rehearsal.ts` | 還原腳本共用區塊（2 段），可抽 `restore-common.ts` |
| `db-monitoring.ts` 內部 2 組 | 該檔 1,836 行為全專案最大檔，重複是拆分時順手處理即可 |

### 🟡 client 端 clone

| 位置 | 說明 |
|---|---|
| `pages/PrintMonthlySalaryPage.tsx` vs `pages/PrintSalaryPage.tsx` | 列印頁前置邏輯 2 段重複，可抽共用 hook/元件 |
| `pages/AttendancePage.tsx:481-500` vs `pages/SettingsPage.tsx:358-377` | 特休設定 UI 區塊重複 |
| `hooks/useAttendanceData.ts` vs `hooks/useSettingsForm.ts` | 設定表單處理重複 |
| `hooks/useHistoryData.ts` 內部 | 小型重複 |

---

## 2. 死碼與未使用依賴掃描（knip，已人工驗證）

### 未使用檔案（34 個）

- **32 個 `client/src/components/ui/*` shadcn 元件**未被任何頁面引用（accordion、carousel、chart、command、drawer、form、sidebar、menubar…）。這是 shadcn 全套安裝的常見現象，本身無害，但它們**連帶拖住 28 個未使用的 npm 依賴**（見下）。
- `scripts/hash-admin-pin.mjs` — 已被 `hash-super-admin-pin.mjs` 取代的舊腳本。
- `test-improved-cipher-es.mjs` — 根目錄的臨時測試腳本，不在任何 test config 中，應刪除或移入 `scripts/`。

### 未使用依賴（28 個 dependencies + 3 個 devDependencies，已抽樣 grep 驗證）

- **完全零引用**：`framer-motion`、`react-icons`（grep 全 client 無任何 import）
- **僅被「未使用的 ui 元件」引用**：`recharts`、`embla-carousel-react`、`cmdk`、`vaul`、`react-hook-form`、`@hookform/resolvers`、`input-otp`、`react-resizable-panels` 及 19 個 `@radix-ui/react-*` 套件
- devDependencies：`@tailwindcss/postcss`（tailwind v3 不需要）、`@types/ws`、`rollup`（vite 自帶）

**影響**：安裝體積與 CI 安裝時間、`npm audit` 攻擊面、Zeabur 建置時間。**注意**：因為都是未使用的程式碼，移除不影響 runtime bundle 大小（Vite tree-shaking 已排除），這是「開發/建置債」而非「效能債」。

**建議**：刪除未使用的 ui 元件檔 + 對應依賴一次處理（一個 commit，`npm run verify:ci` 把關）。保守作法是保留 `form.tsx`/`dialog` 類未來很可能用到的，只刪明確不會用的（carousel、chart、sidebar、menubar、input-otp 等）。

### 值得注意的未使用 export（非 ui、已濾除誤報後的重點）

| 位置 | 說明 |
|---|---|
| `client/src/utils/employeeCache.ts` | 整個模組的所有 export（`initEmployeeCache` 等 4 個）皆未使用——整檔為死碼候選 |
| `client/src/lib/utils.ts` | `calculateOvertimePay`、`extractYearMonth`、`getDeductionAmount`、`isWeekend`、`isHoliday` 5 個函式未使用（疑似被 `salaryCalculations.ts` 取代後殘留） |
| `client/src/lib/queryClient.ts` 的 `getAuthHeaders` | 未使用 |
| `client/src/lib/salaryCalculations.ts` 的 `calculateSimpleOvertime` | 未使用 |
| `server/routes/import-helpers.ts` | 6 個 parse/validate 函式 export 未被 route 使用（部分僅測試引用） |

*註：`runScheduledMonthlySalaryAutomation`、`stopMonthlySalaryScheduler` 等被 knip 標出的項目屬誤報邊緣（由 runtime 進入點/測試使用），已剔除不列。*

---

## 3. 依賴健康（npm audit / outdated）

- **`npm audit`：0 vulnerabilities** ✅
- **overrides 治理良好**：`axios ^1.16.1`（壓住 `@line/liff` 傳遞依賴的舊版 axios）、`lodash 4.18.1`（壓 recharts 傳遞依賴）、`esbuild`、`yaml` 均有明確用途
- 落後情況：

| 類別 | 內容 | 建議 |
|---|---|---|
| Minor/patch 落後（~40 個） | radix-ui 系列、vite 8.0→8.1、vitest 4.1.0→4.1.9、pg、nodemailer 等 | 低風險，例行 `npm update` 即可 |
| Major 落後（刻意鎖定，暫不動） | `express` 4→5、`react` 18→19、`tailwindcss` 3→4、`zod` 已是 v4 | 均屬大遷移，依 `docs/DEPENDENCY_UPDATE_POLICY.md` 節奏處理 |
| Major 落後（可趁清理處理） | `@hookform/resolvers` 3→5（反正未使用，直接移除）、`lucide-react` 0.453→1.x（API 穩定，建議升） | 併入死碼清理 |
| 異常 | `@rollup/rollup-linux-x64-gnu` 在 Windows 顯示 MISSING | 正常（platform-specific optionalDependency），非問題 |

---

## 4. 型別債與 API 呼叫模式（延續 7/1 盤點，數字重新驗證）

- `: any` / `as any`：client 端 **35 處 / 12 檔**（熱點：`useAttendanceData.ts` 9 處、`HistoryTable.tsx` 7 處、`EditHistoryRecordModal.tsx` 5 處）；server 端僅 5 處
- 裸 `fetch()`：client 端 **17 處 / 8 檔**（熱點：`useBarcodeScanner.ts` 5 處、`ClockInPage.tsx` 3 處、`useAdmin.tsx` 3 處），未統一走 `queryClient.ts` 的 `apiRequest()`
- 這兩項與「client 測試覆蓋 9.5%」互為因果：型別鬆 → 重構不敢動 → 測試難補

---

## 5. 結構債（大型檔案，維持 7/1 結論）

| 檔案 | 行數 | 狀態 |
|---|---|---|
| `server/db-monitoring.ts` | 1,836 | 全專案最大檔，含備份/還原/監控多職責 |
| `server/storage.ts` | 1,053 | God Object，拆分計畫已就緒（`docs/superpowers/plans/2026-07-01-storage-repository-split.md`）；本次 race condition 修復已拆出第一個 `monthlySalaryRunRepository` 作為範本 |
| `client/src/pages/AttendancePage.tsx` | 786 | 資料+格式化+UI 混雜 |
| `client/src/hooks/useAttendanceData.ts` | 766 | 巨型 hook |
| `client/src/pages/HistoryPage.tsx` | 679 | 同上 |

---

## 行動建議（依投資報酬排序）

1. **統一薪資計算邏輯至 `shared/`**（🔴 唯一影響金額正確性的債）— 先為三份實作寫「同輸入同輸出」的 characterization test，再合併。估 1-2 天
2. **死碼清理一次性 commit**（低風險高整潔度）— 刪 32 個未使用 ui 元件 + 28 個未使用依賴 + `hash-admin-pin.mjs` + `test-improved-cipher-es.mjs` + `employeeCache.ts` + `lib/utils.ts` 殘留函式，`npm run verify:ci` 把關。估半天
3. **`storage.ts` 改 import `scan-helpers`，刪除拷貝** — 15 分鐘級的修正，順手消除一組真重複
4. **執行既有的 storage 拆分計畫** — 本次新增的 `monthlySalaryRunRepository` 已立下 per-domain repository 範本
5. **裸 `fetch` 收斂到 `apiRequest()` + 清理 client `any` 熱點** — 建議與補 client 測試同步進行
6. **例行 `npm update`**（minor/patch 批次）— 併入下次 release 前的 `verify:release`

---

*本報告與 `CODE_AUDIT_REPORT_2026-07-02.md`（整體品質評分）互補：該報告聚焦評分與已知問題驗證，本報告聚焦工具化深度掃描的新發現。race condition 修復已於本日完成（見 git log），不再列入待辦。*
