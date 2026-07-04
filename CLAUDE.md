# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案概觀

PostgreSQL 為先的員工出勤與薪資管理系統（條碼掃描打卡、薪資自動化、LINE 整合）。此 repo 是 2026-04-12 由私有版本淨室重建的公開版；內部歷史與營運交接資料刻意排除。**專案目標是長期傳承**：永續性與可維護性優先於新功能。

## 常用指令

```bash
npm run dev                 # tsx 啟動 dev server（client 由 Vite middleware 供應）
npm run check               # tsc 型別檢查
npm test                    # vitest 全部單元/整合測試（不含 real-db）
npx vitest run <path>       # 跑單一測試檔
npm run verify:ci           # check + test + build（CI 同款，提交前跑這個）
npm run verify:release      # verify:ci + smoke + restore-check（釋出前）
npm run test:mobile-ui      # Playwright 行動版結構驗收（自動起 dev server，無需真 DB）
npm run test:real-db        # 真資料庫測試——僅本機執行，CI 刻意不設 DB secret
```

## 架構地圖

- `server/`：Express + Drizzle ORM。進入點 `index.ts` → `bootstrap/create-app.ts`（純函式組 app，middleware 順序：trust proxy → security → session → rate limit → body parser → logging，順序有意義勿調換）。
- `server/routes/`：依領域拆分（attendance、salary、scan、employees、line…），helpers 同目錄 `*-helpers.ts`。
- `server/storage.ts`：資料層單一入口（IStorage 介面 + DatabaseStorage）。**正在依計畫拆分為 `server/repositories/` per-domain repository**（範本：`monthlySalaryRunRepository`）。新資料存取邏輯優先放 repository，不要再往 storage.ts 加。
- `shared/`：client/server 共用。`schema.ts`（Drizzle + drizzle-zod，型別單一事實來源）、`utils/salaryMath.ts`（**薪資計算唯一實作**——client/server 各只有薄 adapter，改計薪規則只能改這裡，有 parity test 釘住三處一致）。
- `client/src/`：React 18 + Vite + wouter + TanStack Query。頁面全部 `React.lazy`。API 呼叫應走 `lib/queryClient.ts` 的 `apiRequest()`（裸 fetch 是待清的技術債，勿新增）。
- 環境變數：`server/config/envValidator.ts` 啟動即驗證，production 配置錯誤會直接拒絕啟動（SESSION_SECURE、SESSION_SECRET、明文 SUPER_ADMIN_PIN 等）。範本見 `.env.example`。

## 關鍵慣例

- **字型/資產全自架**：一律走 npm 套件（@fontsource）由 Vite 打包，禁止執行期 CDN；`client/src/lib/selfHostedAssets.test.ts` 會擋。圖示一律 `lucide-react`。
- **併發寫入**：跨請求/跨 process 的寫入競爭用 DB 層原子操作解（參考 `monthlySalaryRunRepository.acquireRun` 與 `upsertTemporaryAttendanceScan` 的 `pg_advisory_xact_lock`），不要用 in-memory 旗標。
- **多筆關聯寫入**包在 `db.transaction`（參考 `storage.saveSalaryRecordsAtomically`）。
- **出勤日期格式**：DB 中同時存在 `YYYY/MM/DD` 與 `YYYY-MM-DD` 兩種，月份查詢須雙 LIKE（見 `getTemporaryAttendanceByMonth`）。
- **設計語言**：紙感主題（`index.css` 的 `--paper`/`--ink`/`--sage` tokens + LXGW WenKai TC）。行動版觸控目標用 Button 的 `size="mobile"`（≥44px）。
- **修復/重構計畫**放 `docs/superpowers/plans/`，稽核報告放 `docs/`（`CODE_AUDIT_REPORT_*`、`TECH_DEBT_REPORT_*`）。動大結構前先讀最新一份。

## 測試策略

- server 端以 integration test 為主（supertest 對 route 層），覆蓋 ~78%；client 端覆蓋仍低（技術債，補測試優先於重構 UI）。
- `*.real-db.test.ts` 需要真 PostgreSQL（`vitest.real-db.config.ts`），僅本機跑；一般 vitest config 已排除。
- Playwright（`client/__tests__/mobile-ui.spec.ts`）做結構性驗收，placeholder DATABASE_URL 即可跑，刻意不用像素快照（平台後綴會讓 CI 必失敗）。

## 營運文件

部署/設定/維護/事故處理見 `docs/`：`OPERATIONS_RUNBOOK.md`（備份還原、事故）、`MAINTENANCE.md`（週/月/季節奏）、`DEPENDENCY_UPDATE_POLICY.md`（major 升級刻意鎖定的清單）、`ZEABUR_BUILD_CONTRACT.md`（部署平台建置約定）。
