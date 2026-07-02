import { test, expect, type Page } from "@playwright/test";

/**
 * Mobile UI 結構性驗收測試(iPhone 12 viewport,由 playwright.config.ts 的
 * mobile-chromium project 提供)。
 *
 * 刻意不使用 toHaveScreenshot 像素比對:快照檔名帶平台後綴
 * (win32/linux),本機(Windows)產生的 baseline 在 CI(Linux)必定失敗。
 * 改以確定性的結構斷言(導覽列、水平溢出、未捕捉例外)守住排版回歸,
 * 並將整頁截圖存為 artifacts 供人工快速目視。
 *
 * dev server 可在無真實資料庫時啟動(placeholder DATABASE_URL),
 * 頁面資料區塊會呈現錯誤/空狀態 —— 因此斷言僅針對 AppShell 結構,
 * 不依賴 API 資料內容。
 */

const SCREENSHOT_DIR = "test-results/mobile-screenshots";

const MAIN_ROUTES: Array<{ path: string; name: string }> = [
  { path: "/", name: "attendance" },
  { path: "/attendance", name: "attendance-alias" },
  { path: "/employees", name: "employees" },
  { path: "/history", name: "history" },
  { path: "/settings", name: "settings" },
];

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  return errors;
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  });
  expect(overflow, "頁面不應出現水平溢出(排版破版)").toBeLessThanOrEqual(2);
}

test.describe("mobile shell structure", () => {
  for (const route of MAIN_ROUTES) {
    test(`${route.path} renders mobile shell without layout breakage`, async ({
      page,
    }) => {
      const pageErrors = collectPageErrors(page);

      await page.goto(route.path, { waitUntil: "domcontentloaded" });

      // AppShell mobile 版:上方 sticky header + 下方固定 tab bar
      await expect(page.locator("header").first()).toBeVisible();

      const navBar = page.locator("nav").last();
      await expect(navBar).toBeVisible();

      // 底部導覽至少 4 個 tab(barcode 停用時為 4,啟用時為 5)
      const tabCount = await navBar.locator("button").count();
      expect(tabCount, "底部導覽 tab 數量").toBeGreaterThanOrEqual(4);

      await assertNoHorizontalOverflow(page);

      await page.screenshot({
        path: `${SCREENSHOT_DIR}/${route.name}.png`,
        fullPage: true,
      });

      expect(pageErrors, "不應有未捕捉的 JS 例外").toEqual([]);
    });
  }

  test("bottom nav tab navigates between pages", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // 先等 shell 完成掛載(useIsMobile 翻轉後才會渲染底部導覽)
    await expect(page.locator("header").first()).toBeVisible();

    const navBar = page.locator("nav").last();
    await expect(navBar).toBeVisible();

    await navBar.getByRole("button", { name: "員工" }).click();
    await expect(page).toHaveURL(/\/employees$/);

    // 切換後 shell 依然完整
    await expect(page.locator("header").first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });
});

test.describe("standalone pages", () => {
  test("/print-salary loads without crashing on mobile", async ({ page }) => {
    const pageErrors = collectPageErrors(page);

    await page.goto("/print-salary", { waitUntil: "domcontentloaded" });

    // 無 token/參數時允許顯示空狀態或錯誤訊息,但不可整頁空白或崩潰
    await expect(page.locator("body")).not.toBeEmpty();
    await assertNoHorizontalOverflow(page);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/print-salary.png`,
      fullPage: true,
    });

    expect(pageErrors, "不應有未捕捉的 JS 例外").toEqual([]);
  });
});
