import { describe, expect, it, vi } from "vitest";

import {
  getIdleScheduler,
  preloadMainTab,
  registerMainTabPreloader,
} from "@/lib/mainTabPreload";

describe("main tab preload", () => {
  it("runs registered preloaders for known tabs", async () => {
    const preload = vi.fn().mockResolvedValue(undefined);
    registerMainTabPreloader("settings", preload);

    await preloadMainTab("settings");

    expect(preload).toHaveBeenCalledTimes(1);
  });

  it("returns a fallback scheduler when window is unavailable", () => {
    const scheduler = getIdleScheduler();

    expect(typeof scheduler.schedule).toBe("function");
    expect(typeof scheduler.cancel).toBe("function");
  });
});
