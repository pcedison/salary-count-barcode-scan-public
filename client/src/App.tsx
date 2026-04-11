import { lazy, Suspense, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Route, Switch, useLocation } from "wouter";

import { Toaster } from "@/components/ui/toaster";
import { AdminProvider } from "@/hooks/useAdmin";
import { MAIN_NAV_ITEMS, getMainTabForPath, getPathForMainTab, type MainTab } from "@/lib/appNavigation";
import { queryClient } from "./lib/queryClient";
import type { PublicSettingsPayload } from "@shared/settings";

const AttendancePage = lazy(() => import("@/pages/AttendancePage"));
const HistoryPage = lazy(() => import("@/pages/HistoryPage"));
const SettingsPage = lazy(() => import("@/pages/SettingsPage"));
const PrintSalaryPage = lazy(() => import("@/pages/PrintSalaryPage"));
const BarcodeScanPage = lazy(() => import("@/pages/BarcodeScanPage"));
const EmployeesPage = lazy(() => import("@/pages/EmployeesPage"));
const NotFound = lazy(() => import("@/pages/not-found"));
const ClockInPage = lazy(() => import("@/pages/ClockInPage"));
const QRCodePage = lazy(() => import("@/pages/QRCodePage"));

const APP_TITLE = "員工薪資計算系統";
const APP_VERSION = "1.0.0";

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
          {APP_TITLE} &copy; 2025 版本 {APP_VERSION}
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
