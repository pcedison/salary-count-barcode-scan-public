import { lazy, Suspense, useEffect, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Route, Switch, useLocation } from "wouter";

import { Toaster } from "@/components/ui/toaster";
import { AdminProvider } from "@/hooks/useAdmin";
import { MAIN_NAV_ITEMS, getMainTabForPath, getPathForMainTab, type MainTab } from "@/lib/appNavigation";
import { getIdleScheduler, preloadMainTab, registerMainTabPreloader } from "@/lib/mainTabPreload";
import { queryClient } from "./lib/queryClient";
import type { PublicSettingsPayload } from "@shared/settings";

const loadAttendancePage = () => import("@/pages/AttendancePage");
const loadHistoryPage = () => import("@/pages/HistoryPage");
const loadSettingsPage = () => import("@/pages/SettingsPage");
const loadPrintSalaryPage = () => import("@/pages/PrintSalaryPage");
const loadBarcodeScanPage = () => import("@/pages/BarcodeScanPage");
const loadEmployeesPage = () => import("@/pages/EmployeesPage");
const loadNotFoundPage = () => import("@/pages/not-found");
const loadClockInPage = () => import("@/pages/ClockInPage");
const loadQRCodePage = () => import("@/pages/QRCodePage");

const AttendancePage = lazy(loadAttendancePage);
const HistoryPage = lazy(loadHistoryPage);
const SettingsPage = lazy(loadSettingsPage);
const PrintSalaryPage = lazy(loadPrintSalaryPage);
const BarcodeScanPage = lazy(loadBarcodeScanPage);
const EmployeesPage = lazy(loadEmployeesPage);
const NotFound = lazy(loadNotFoundPage);
const ClockInPage = lazy(loadClockInPage);
const QRCodePage = lazy(loadQRCodePage);

registerMainTabPreloader("attendance", loadAttendancePage);
registerMainTabPreloader("barcode", loadBarcodeScanPage);
registerMainTabPreloader("employees", loadEmployeesPage);
registerMainTabPreloader("history", loadHistoryPage);
registerMainTabPreloader("settings", loadSettingsPage);

const APP_TITLE = "員工薪資計算系統";
const APP_VERSION = __APP_VERSION__;
const APP_COPYRIGHT_YEAR = new Date().getFullYear();

const MAIN_TAB_COMPONENTS: Record<MainTab, LazyExoticComponent<ComponentType>> = {
  attendance: AttendancePage,
  barcode: BarcodeScanPage,
  employees: EmployeesPage,
  history: HistoryPage,
  settings: SettingsPage,
};

function LoadingFallback({ fullScreen = false }: { fullScreen?: boolean }) {
  const className = fullScreen
    ? "flex min-h-screen items-center justify-center text-gray-400"
    : "flex justify-center py-12 text-gray-400";

  return <div className={className}>載入中…</div>;
}

function MainLayout({
  activeTab,
  children,
  barcodeEnabled,
}: {
  activeTab: MainTab;
  children: ReactNode;
  barcodeEnabled: boolean;
}) {
  const [location, setLocation] = useLocation();
  const resolvedActiveTab = getMainTabForPath(location) ?? activeTab;
  const navItems = barcodeEnabled
    ? MAIN_NAV_ITEMS
    : MAIN_NAV_ITEMS.filter((item) => item.tab !== "barcode");

  useEffect(() => {
    const scheduler = getIdleScheduler();
    const idleHandle = scheduler.schedule(() => {
      for (const item of navItems) {
        if (item.tab === resolvedActiveTab) {
          continue;
        }

        void preloadMainTab(item.tab);
      }
    });

    return () => scheduler.cancel(idleHandle);
  }, [navItems, resolvedActiveTab]);

  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <div className="mx-auto max-w-7xl overflow-hidden rounded-lg bg-white shadow-md">
        <div className="border-b border-gray-200">
          <div className="flex items-center justify-between p-6">
            <h1 className="text-2xl font-medium text-gray-800">{APP_TITLE}</h1>
          </div>

          <div className="flex overflow-x-auto border-b border-gray-200 px-6">
            {navItems.map((item) => (
              <button
                key={item.tab}
                type="button"
                className={`whitespace-nowrap px-6 py-3 ${
                  resolvedActiveTab === item.tab
                    ? "border-b-2 border-primary font-medium text-primary"
                    : "text-gray-500 hover:text-gray-700"
                }`}
                onClick={() => {
                  if (resolvedActiveTab !== item.tab) {
                    setLocation(getPathForMainTab(item.tab));
                  }
                }}
                onMouseEnter={() => {
                  void preloadMainTab(item.tab);
                }}
                onFocus={() => {
                  void preloadMainTab(item.tab);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6">
          <Suspense fallback={<LoadingFallback />}>{children}</Suspense>
        </div>

        <div className="border-t border-gray-200 bg-gray-50 px-6 py-4 text-center text-sm text-gray-500">
          {APP_TITLE} &copy; {APP_COPYRIGHT_YEAR} 版本 {APP_VERSION}
        </div>
      </div>
    </div>
  );
}

function MainRoute({ tab, barcodeEnabled }: { tab: MainTab; barcodeEnabled: boolean }) {
  const Page = MAIN_TAB_COMPONENTS[tab];

  return (
    <MainLayout activeTab={tab} barcodeEnabled={barcodeEnabled}>
      <Page />
    </MainLayout>
  );
}

function Router() {
  const { data: settings } = useQuery<PublicSettingsPayload>({ queryKey: ["/api/settings"] });
  const barcodeEnabled = settings?.barcodeEnabled !== false;
  const routeItems = barcodeEnabled
    ? MAIN_NAV_ITEMS
    : MAIN_NAV_ITEMS.filter((item) => item.tab !== "barcode");

  return (
    <Suspense fallback={<LoadingFallback fullScreen />}>
      <Switch>
        {routeItems.map((item) => (
          <Route
            key={item.path}
            path={item.path}
            component={() => <MainRoute tab={item.tab} barcodeEnabled={barcodeEnabled} />}
          />
        ))}
        <Route path="/print-salary" component={PrintSalaryPage} />
        <Route path="/clock-in" component={ClockInPage} />
        <Route path="/qrcode" component={QRCodePage} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AdminProvider>
        <Router />
        <Toaster />
      </AdminProvider>
    </QueryClientProvider>
  );
}

export default App;
