// client/src/App.tsx — 完整替換版本
// 改動：MainLayout → AppShell（左側可收合側邊欄）
// 其他邏輯（路由、lazy 載入、TanStack Query、AdminProvider）完全不動

import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Route, Switch } from "wouter";

import { Toaster } from "@/components/ui/toaster";
import { AdminProvider } from "@/hooks/useAdmin";
import { AppShell } from "@/components/layout/AppShell";          // ← 新增
import { MAIN_NAV_ITEMS, getPathForMainTab, type MainTab } from "@/lib/appNavigation";
import { registerMainTabPreloader } from "@/lib/mainTabPreload";
import { queryClient } from "./lib/queryClient";
import type { PublicSettingsPayload } from "@shared/settings";

// ── Lazy 載入（不動） ─────────────────────────────────────────────────
const loadAttendancePage  = () => import("@/pages/AttendancePage");
const loadHistoryPage     = () => import("@/pages/HistoryPage");
const loadSettingsPage    = () => import("@/pages/SettingsPage");
const loadPrintSalaryPage = () => import("@/pages/PrintSalaryPage");
const loadBarcodeScanPage = () => import("@/pages/BarcodeScanPage");
const loadEmployeesPage   = () => import("@/pages/EmployeesPage");
const loadNotFoundPage    = () => import("@/pages/not-found");
const loadClockInPage     = () => import("@/pages/ClockInPage");
const loadQRCodePage      = () => import("@/pages/QRCodePage");

const AttendancePage  = lazy(loadAttendancePage);
const HistoryPage     = lazy(loadHistoryPage);
const SettingsPage    = lazy(loadSettingsPage);
const PrintSalaryPage = lazy(loadPrintSalaryPage);
const BarcodeScanPage = lazy(loadBarcodeScanPage);
const EmployeesPage   = lazy(loadEmployeesPage);
const NotFound        = lazy(loadNotFoundPage);
const ClockInPage     = lazy(loadClockInPage);
const QRCodePage      = lazy(loadQRCodePage);

registerMainTabPreloader("attendance", loadAttendancePage);
registerMainTabPreloader("barcode",    loadBarcodeScanPage);
registerMainTabPreloader("employees",  loadEmployeesPage);
registerMainTabPreloader("history",    loadHistoryPage);
registerMainTabPreloader("settings",   loadSettingsPage);

// ── 常數（不動） ──────────────────────────────────────────────────────
const APP_TITLE   = "員工薪資計算系統";
const APP_VERSION = __APP_VERSION__;

const MAIN_TAB_COMPONENTS: Record<MainTab, LazyExoticComponent<ComponentType>> = {
  attendance: AttendancePage,
  barcode:    BarcodeScanPage,
  employees:  EmployeesPage,
  history:    HistoryPage,
  settings:   SettingsPage,
};

// ── Loading fallback ──────────────────────────────────────────────────
function LoadingFallback({ fullScreen = false }: { fullScreen?: boolean }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'center', alignItems: fullScreen ? 'center' : 'flex-start',
      minHeight: fullScreen ? '100vh' : 'auto', paddingTop: fullScreen ? 0 : 48,
      color: 'var(--ink-3)', fontFamily: 'var(--font-kai)', letterSpacing: '0.15em',
    }}>載入中…</div>
  );
}

// ── 帶殼頁面（取代舊 MainLayout） ─────────────────────────────────────
function MainRoute({ tab, barcodeEnabled }: { tab: MainTab; barcodeEnabled: boolean }) {
  const Page = MAIN_TAB_COMPONENTS[tab];
  return (
    <AppShell activeTab={tab} barcodeEnabled={barcodeEnabled}
              appTitle={APP_TITLE} appVersion={APP_VERSION}>
      <Suspense fallback={<LoadingFallback />}>
        <Page />
      </Suspense>
    </AppShell>
  );
}

// ── 路由（不動） ──────────────────────────────────────────────────────
function Router() {
  const { data: settings } = useQuery<PublicSettingsPayload>({ queryKey: ["/api/settings"] });
  const barcodeEnabled = settings?.barcodeEnabled !== false;
  const routeItems = barcodeEnabled
    ? MAIN_NAV_ITEMS
    : MAIN_NAV_ITEMS.filter(i => i.tab !== "barcode");

  return (
    <Suspense fallback={<LoadingFallback fullScreen />}>
      <Switch>
        {routeItems.map(item => (
          <Route
            key={item.path}
            path={item.path}
            component={() => <MainRoute tab={item.tab} barcodeEnabled={barcodeEnabled} />}
          />
        ))}
        {/* 獨立頁面（不使用 AppShell） */}
        <Route path="/print-salary" component={PrintSalaryPage} />
        <Route path="/clock-in"     component={ClockInPage} />
        <Route path="/qrcode"       component={QRCodePage} />
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
