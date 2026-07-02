import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT) || 5000;

export default defineConfig({
  testDir: "./client/__tests__",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "html",
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
    },
  },
});
