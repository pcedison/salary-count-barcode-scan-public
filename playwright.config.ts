import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT) || 5000;

export default defineConfig({
  testDir: "./client/__tests__",
  // 所有測試共用同一個 dev server;並行會造成 Vite 冷轉換風暴,
  // lazy page chunk 載入逾時(Suspense fallback 期間 shell 不渲染)。
  // 序列執行讓第一個測試暖機,其餘測試走已轉換的模組快取。
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "html",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "mobile-chromium",
      use: { ...devices["iPhone 12"], browserName: "chromium" },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
    env: {
      // dev 模式僅強制要求 DATABASE_URL(格式需為 postgres URL)。
      // 無資料庫時頁面會以錯誤/空狀態呈現,結構性檢查仍可執行。
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://placeholder:placeholder@127.0.0.1:9/placeholder",
      PORT: String(PORT),
      // server/index.ts 依 NODE_ENV === 'development' 決定啟用 Vite middleware
      NODE_ENV: "development",
      // 隔離 runtime 目錄,避免測試用 server 讀寫本機真實執行個體的備份/日誌
      APP_RUNTIME_DIR: "test-results/.acceptance-runtime",
      APP_BACKUP_DIR: "test-results/.acceptance-runtime/backups",
      APP_LOG_DIR: "test-results/.acceptance-runtime/logs",
    },
  },
});
