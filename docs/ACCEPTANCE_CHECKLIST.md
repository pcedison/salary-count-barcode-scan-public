# 合併前驗收清單(Pre-Merge Acceptance Checklist)

本文件說明程式碼合併回 `main` 前的驗收方式。驗收由三層組成:CI 自動門檻、本機一鍵腳本、少量人工目視。

## 一鍵執行(本機)

```bash
./scripts/verify-acceptance.sh
```

腳本依序執行三項檢查,任何一項失敗即以非零碼結束:

| 檢查 | 內容 | 失敗條件 |
|------|------|----------|
| 環境守門 | `DATABASE_URL` 是否已設定 | 未設定(real-db 測試同時被略過) |
| 真實資料庫測試 | `npm run test:real-db` | 任一 integration 測試失敗 |
| Mobile UI 結構檢查 | `npm run test:mobile-ui` | 任一結構斷言失敗 |

---

## 1. 真實資料庫測試(`npm run test:real-db`)

**做什麼:** 對真實 PostgreSQL(Supabase)執行三組 integration 測試:

- `test:real-db:retention` — 資料保留政策
- `test:real-db:rehearsal` — 還原演練
- `test:real-db:monthly-salary-run` — 月結薪資 run(含競態條件防護)

**本機執行:**

```bash
# 指向「測試用」資料庫(schema 與正式庫一致),不要指向正式庫
export DATABASE_URL="postgresql://user:password@host:5432/dbname"

npm run test:real-db
```

**通過標準:** 全部測試 PASS(0 failures)。

**常見失敗原因:**

- 連線失敗 → 確認 `DATABASE_URL` 可達:`psql "$DATABASE_URL" -c "SELECT 1"`
- Schema 不一致 → 以 `npm run db:push`(drizzle-kit)同步 schema 到測試庫
- 前次測試殘留資料 → 測試設計為自我清理;若仍殘留,檢查測試輸出中的清理警告

**CI 行為:** `.github/workflows/acceptance.yml` 的 `real-db` job 為 **opt-in**——只有在 repo 設定了 `REAL_DB_TEST_DATABASE_URL` secret 時才執行;未設定時以 notice 略過並提示改為本機執行。此設計是刻意的:避免 CI 誤連正式庫。

> ⚠️ `REAL_DB_TEST_DATABASE_URL` 必須指向測試庫,**絕不可指向正式庫**。

---

## 2. Mobile UI 結構檢查(`npm run test:mobile-ui`)

**做什麼:** 以 Playwright(iPhone 12 viewport,390×844)對主要頁面執行**結構性斷言**,並將整頁截圖存為 artifacts 供人工快速目視:

- 五個主要路由(`/`、`/attendance`、`/employees`、`/history`、`/settings`)+ `/print-salary`
- 每頁斷言:header 與底部導覽列可見、tab 數 ≥ 4、**無水平溢出**(排版破版)、**無未捕捉 JS 例外**
- 底部導覽 tab 點擊後正確切換路由

**為什麼不用像素快照(toHaveScreenshot):** Playwright 快照檔名帶平台後綴(`-win32`/`-linux`),本機 Windows 產生的 baseline 在 Linux CI 上必定失敗;字型渲染差異也會產生大量誤報。結構性斷言跨平台穩定,截圖仍保留供目視。

**本機執行:**

```bash
npm run test:mobile-ui
```

不需要真實資料庫——`playwright.config.ts` 的 webServer 會以 placeholder `DATABASE_URL` 自動啟動 dev server(port 5000);頁面資料區塊呈現錯誤/空狀態,但 shell 結構檢查照常執行。若你的環境已設定真實 `DATABASE_URL`,會自動沿用,截圖將包含真實資料畫面。

**截圖位置:** `test-results/mobile-screenshots/*.png`(已 gitignore;CI 上傳為 artifacts,保留 14 天)。

**常見失敗原因:**

- 「無水平溢出」失敗 → 某元素寬度超出 390px viewport,檢查對應頁面最近的樣式改動
- 「未捕捉 JS 例外」失敗 → 測試輸出會列出例外訊息;通常是新程式碼在 mobile 佈局下的 runtime error
- webServer 啟動逾時 → port 5000 被占用,或 `npm run dev` 本身失敗(先手動跑一次確認)

---

## 3. 人工目視(僅在 UI 有意變動時)

自動檢查涵蓋「破版與崩潰」,不涵蓋「好不好看」。UI 有意變動時,合併前請看一眼截圖:

1. 本機跑 `npm run test:mobile-ui` 後打開 `test-results/mobile-screenshots/`
2. 或從 PR 的 Actions → `Acceptance` → `mobile-ui-screenshots` artifact 下載

---

## CI 總覽

| Workflow | Job | 觸發 | 阻擋合併 |
|----------|-----|------|----------|
| `ci.yml` | required-checks(verify:release)| 每個 PR | 是 |
| `ci.yml` | docker-smoke | 每個 PR | 是 |
| `acceptance.yml` | mobile-ui | 每個 PR | 是 |
| `acceptance.yml` | real-db | 每個 PR(需 secret)| 設定 secret 後才實際執行 |

---

## 給審查者

核准 PR 前:

1. ✅ `CI` 與 `Acceptance` workflow 皆綠
2. ✅ real-db job 若被略過(secret 未設定),確認作者已在本機跑過 `npm run test:real-db` 並在 PR 註明
3. ✅ UI 變動的 PR:下載 `mobile-ui-screenshots` artifact 目視確認
