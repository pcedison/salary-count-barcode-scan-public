import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  History as HistoryIcon,
  ScanLine,
  Settings2,
  Users2,
} from "lucide-react";
import { useLocation } from "wouter";

import { useIsMobile } from "@/hooks/use-mobile";
import {
  MAIN_NAV_ITEMS,
  getMainTabForPath,
  getPathForMainTab,
  type MainTab,
} from "@/lib/appNavigation";
import { getIdleScheduler, preloadMainTab } from "@/lib/mainTabPreload";
import { cn } from "@/lib/utils";

const TAB_ICONS: Record<MainTab, ComponentType<{ className?: string }>> = {
  attendance: Clock3,
  barcode: ScanLine,
  employees: Users2,
  history: HistoryIcon,
  settings: Settings2,
};

const MOBILE_TAB_LABELS: Record<MainTab, string> = {
  attendance: "考勤",
  barcode: "掃碼",
  employees: "員工",
  history: "紀錄",
  settings: "設定",
};

const NAV_SECTIONS: Array<{ label: string; tabs: MainTab[] }> = [
  { label: "打卡作業", tabs: ["attendance", "barcode"] },
  { label: "人員管理", tabs: ["employees", "history"] },
  { label: "系統", tabs: ["settings"] },
];

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn(
        "grid shrink-0 place-items-center rounded-2xl bg-[linear-gradient(145deg,var(--sage)_0%,var(--sage-deep)_100%)] text-white shadow-[0_10px_24px_rgba(79,115,101,0.24)]",
        compact ? "h-11 w-11 text-2xl" : "h-10 w-10 text-xl",
      )}
      aria-hidden="true"
    >
      勤
    </div>
  );
}

function DesktopNavButton({
  collapsed,
  isActive,
  label,
  onClick,
  Icon,
}: {
  collapsed: boolean;
  isActive: boolean;
  label: string;
  onClick: () => void;
  Icon: ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        "group relative flex w-full items-center rounded-2xl border text-left transition-all",
        collapsed ? "justify-center px-0 py-3" : "gap-3 px-4 py-3",
        isActive
          ? "border-[var(--line-soft)] bg-white text-[var(--sage-deep)] shadow-sm"
          : "border-transparent text-[var(--ink-2)] hover:bg-white/70 hover:text-[var(--ink-1)]",
      )}
    >
      {!collapsed && isActive ? (
        <span className="absolute left-0 top-1/2 h-9 w-1 -translate-y-1/2 rounded-r-full bg-[var(--sage)]" />
      ) : null}
      <Icon
        className={cn(
          "h-5 w-5 shrink-0 transition-colors",
          isActive ? "text-[var(--sage)]" : "text-[var(--ink-3)] group-hover:text-[var(--sage-deep)]",
        )}
      />
      {!collapsed ? <span className="truncate text-[15px]">{label}</span> : null}
    </button>
  );
}

function MobileNavButton({
  isActive,
  label,
  onClick,
  Icon,
}: {
  isActive: boolean;
  label: string;
  onClick: () => void;
  Icon: ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-w-0 flex-col items-center justify-center gap-1 rounded-2xl px-2 py-2 text-center transition-colors",
        isActive
          ? "bg-white text-[var(--sage-deep)] shadow-[0_8px_20px_rgba(42,46,42,0.08)]"
          : "text-[var(--ink-3)] hover:bg-white/70 hover:text-[var(--ink-1)]",
      )}
    >
      <Icon
        className={cn(
          "h-5 w-5",
          isActive ? "text-[var(--sage)]" : "text-[var(--ink-3)]",
        )}
      />
      <span className="text-[11px] font-medium tracking-[0.08em]">{label}</span>
    </button>
  );
}

export function AppShell({
  activeTab,
  barcodeEnabled,
  children,
  appTitle = "員工薪資計算系統",
  appVersion = "",
}: {
  activeTab: MainTab;
  barcodeEnabled: boolean;
  children: ReactNode;
  appTitle?: string;
  appVersion?: string;
}) {
  const isMobile = useIsMobile();
  const [location, setLocation] = useLocation();
  const [collapsed, setCollapsed] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem("kq.desktopCollapsed") === "1",
  );

  useEffect(() => {
    window.localStorage.setItem("kq.desktopCollapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  const resolvedTab = getMainTabForPath(location) ?? activeTab;
  const navItems = useMemo(
    () =>
      barcodeEnabled
        ? MAIN_NAV_ITEMS
        : MAIN_NAV_ITEMS.filter((item) => item.tab !== "barcode"),
    [barcodeEnabled],
  );
  const currentItem =
    navItems.find((item) => item.tab === resolvedTab) ??
    MAIN_NAV_ITEMS.find((item) => item.tab === resolvedTab) ??
    navItems[0];
  const currentYear = new Date().getFullYear();

  useEffect(() => {
    const scheduler = getIdleScheduler();
    const handle = scheduler.schedule(() => {
      navItems.forEach((item) => {
        if (item.tab !== resolvedTab) {
          void preloadMainTab(item.tab);
        }
      });
    });

    return () => scheduler.cancel(handle);
  }, [navItems, resolvedTab]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [resolvedTab]);

  const goToTab = (tab: MainTab) => {
    const nextPath = getPathForMainTab(tab);
    if (nextPath !== location) {
      setLocation(nextPath);
    }
  };

  if (isMobile) {
    return (
      <div className="min-h-screen bg-[var(--paper)] text-[var(--ink-1)]">
        <header className="sticky top-0 z-40 border-b border-[var(--line-soft)] bg-[rgba(251,250,246,0.94)] backdrop-blur">
          <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3">
            <BrandMark compact />

            <div className="min-w-0 flex-1">
              <p className="truncate text-[10px] uppercase tracking-[0.24em] text-[var(--ink-3)]">
                {appTitle}
              </p>
              <div className="mt-1 flex items-center gap-2">
                <h1 className="truncate text-lg font-semibold tracking-[0.04em] text-[var(--ink-1)]">
                  {currentItem?.label}
                </h1>
                {appVersion ? (
                  <span className="shrink-0 rounded-full border border-[var(--line)] bg-white/80 px-2 py-0.5 text-[10px] tracking-[0.16em] text-[var(--ink-3)]">
                    v{appVersion}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl px-4 pb-28 pt-4">
          {children}

          <footer className="mt-6 pb-2 text-center text-[11px] tracking-[0.14em] text-[var(--ink-3)]">
            {appTitle} &copy; {currentYear}
          </footer>
        </main>

        <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--line-soft)] bg-[rgba(251,250,246,0.96)] shadow-[0_-10px_30px_rgba(42,46,42,0.08)] backdrop-blur">
          <div
            className="mx-auto grid max-w-6xl gap-1 px-2 pt-2"
            style={{
              gridTemplateColumns: `repeat(${navItems.length}, minmax(0, 1fr))`,
              paddingBottom: "calc(env(safe-area-inset-bottom) + 0.5rem)",
            }}
          >
            {navItems.map((item) => {
              const Icon = TAB_ICONS[item.tab];

              return (
                <MobileNavButton
                  key={item.tab}
                  isActive={item.tab === resolvedTab}
                  label={MOBILE_TAB_LABELS[item.tab]}
                  Icon={Icon}
                  onClick={() => goToTab(item.tab)}
                />
              );
            })}
          </div>
        </nav>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--paper)] text-[var(--ink-1)]">
      <div className="mx-auto flex min-h-screen max-w-[1680px]">
        <aside
          className={cn(
            "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-[var(--line)] bg-[var(--paper-soft)] transition-[width] duration-300 md:flex",
            collapsed ? "w-[92px]" : "w-[280px]",
          )}
        >
          <div
            className={cn(
              "border-b border-[var(--line-soft)]",
              collapsed ? "px-0 py-5" : "px-5 py-5",
            )}
          >
            <div
              className={cn(
                "flex items-center",
                collapsed ? "justify-center" : "gap-3",
              )}
            >
              <BrandMark />

              {!collapsed ? (
                <div className="min-w-0">
                  <div className="truncate text-base font-semibold tracking-[0.08em] text-[var(--ink-1)]">
                    考勤薪資
                  </div>
                  <div className="mt-1 text-[11px] tracking-[0.18em] text-[var(--ink-3)]">
                    BARCODE · V3
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-5">
            {NAV_SECTIONS.map((section) => {
              const sectionItems = section.tabs
                .filter((tab) => barcodeEnabled || tab !== "barcode")
                .map((tab) => navItems.find((item) => item.tab === tab))
                .filter((item): item is NonNullable<typeof item> => Boolean(item));

              if (sectionItems.length === 0) {
                return null;
              }

              return (
                <section key={section.label}>
                  {!collapsed ? (
                    <div className="px-3 pb-2 text-[11px] font-medium tracking-[0.24em] text-[var(--ink-3)]">
                      {section.label}
                    </div>
                  ) : (
                    <div className="mx-3 mb-3 h-px bg-[var(--line)]" />
                  )}

                  <div className="space-y-1">
                    {sectionItems.map((item) => {
                      const Icon = TAB_ICONS[item.tab];

                      return (
                        <DesktopNavButton
                          key={item.tab}
                          collapsed={collapsed}
                          isActive={item.tab === resolvedTab}
                          label={item.label}
                          Icon={Icon}
                          onClick={() => goToTab(item.tab)}
                        />
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </nav>

          <div className="border-t border-[var(--line-soft)] p-4">
            <div
              className={cn(
                "flex items-center rounded-2xl bg-white/70",
                collapsed ? "justify-center px-0 py-3" : "gap-3 px-3 py-3",
              )}
            >
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[linear-gradient(135deg,#7A9AB3_0%,#6B8E7F_100%)] text-sm text-white">
                管
              </div>
              {!collapsed ? (
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--ink-1)]">管理員</div>
                  <div className="text-[11px] tracking-[0.14em] text-[var(--ink-3)]">
                    已登入
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 border-b border-[var(--line-soft)] bg-[rgba(251,250,246,0.88)] backdrop-blur">
            <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-6 py-4 xl:px-8">
              <button
                type="button"
                onClick={() => setCollapsed((current) => !current)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-[var(--line)] bg-white text-[var(--ink-2)] transition-colors hover:text-[var(--ink-1)]"
                title={collapsed ? "展開側邊欄" : "收合側邊欄"}
              >
                {collapsed ? (
                  <ChevronRight className="h-5 w-5" />
                ) : (
                  <ChevronLeft className="h-5 w-5" />
                )}
              </button>

              <div className="min-w-0 flex-1">
                <div className="text-xs tracking-[0.18em] text-[var(--ink-3)]">
                  {appTitle}
                </div>
                <div className="mt-1 truncate text-xl font-semibold tracking-[0.04em] text-[var(--ink-1)]">
                  {currentItem?.label}
                </div>
              </div>

              {appVersion ? (
                <div className="rounded-full border border-[var(--line)] bg-white/80 px-3 py-1 text-xs tracking-[0.16em] text-[var(--ink-3)]">
                  v{appVersion}
                </div>
              ) : null}
            </div>
          </header>

          <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6 xl:px-8">
            {children}
          </main>

          <footer className="border-t border-[var(--line-soft)] px-6 py-4 text-center text-xs tracking-[0.16em] text-[var(--ink-3)] xl:px-8">
            {appTitle} &copy; {currentYear}
            {appVersion ? ` 版本 ${appVersion}` : ""}
          </footer>
        </div>
      </div>
    </div>
  );
}
