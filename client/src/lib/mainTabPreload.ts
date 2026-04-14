import type { MainTab } from "@/lib/appNavigation";

type PreloadCallback = () => Promise<unknown>;

const preloaders = new Map<MainTab, PreloadCallback>();

export function registerMainTabPreloader(
  tab: MainTab,
  preload: PreloadCallback,
) {
  preloaders.set(tab, preload);
}

export function preloadMainTab(tab: MainTab) {
  return preloaders.get(tab)?.();
}

export function getIdleScheduler() {
  if (typeof window === "undefined") {
    return {
      schedule: (_callback: () => void) => 0,
      cancel: (_id: number) => {},
    };
  }

  if ("requestIdleCallback" in window && "cancelIdleCallback" in window) {
    return {
      schedule: (callback: () => void) =>
        window.requestIdleCallback(() => callback(), { timeout: 1500 }),
      cancel: (id: number) => window.cancelIdleCallback(id),
    };
  }

  return {
    schedule: (callback: () => void) => window.setTimeout(callback, 300),
    cancel: (id: number) => window.clearTimeout(id),
  };
}
