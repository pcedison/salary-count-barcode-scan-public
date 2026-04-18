// client/src/components/layout/AppShell.tsx
// 取代 App.tsx 中的 MainLayout，加入左側可收合側邊欄
// 放入 client/src/components/layout/ 後，在 App.tsx 引入即可

import { useState, useEffect, type ReactNode } from "react";
import { useLocation } from "wouter";
import { MAIN_NAV_ITEMS, getMainTabForPath, getPathForMainTab, type MainTab } from "@/lib/appNavigation";
import { preloadMainTab, getIdleScheduler } from "@/lib/mainTabPreload";

// ── 同一份圖示（AppShell 不依賴 Sidebar.tsx，可獨立使用）────────────
const Ico = ({ children, size = 18 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const IcoClock    = ({ size }: { size?: number }) => <Ico size={size}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/></Ico>;
const IcoBarcode  = ({ size }: { size?: number }) => <Ico size={size}><path d="M4 6v12M7 6v12M10 6v8M13 6v12M16 6v8M19 6v12"/><path d="M3 17v2h3M21 17v2h-3M3 7V5h3M21 7V5h-3"/></Ico>;
const IcoUsers    = ({ size }: { size?: number }) => <Ico size={size}><circle cx="9" cy="8" r="3.3"/><path d="M2.8 20c.7-3.4 3.3-5.5 6.2-5.5S14.5 16.6 15.2 20"/><circle cx="17" cy="7.5" r="2.6"/><path d="M16 14.3c2.8-.2 4.8 1.5 5.2 4.3"/></Ico>;
const IcoHistory  = ({ size }: { size?: number }) => <Ico size={size}><path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/></Ico>;
const IcoSettings = ({ size }: { size?: number }) => <Ico size={size}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01A1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></Ico>;
const IcoSidebar  = ({ size }: { size?: number }) => <Ico size={size}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></Ico>;
const IcoChevronR = ({ size }: { size?: number }) => <Ico size={size}><path d="M9 6l6 6-6 6"/></Ico>;
const IcoChevronL = ({ size }: { size?: number }) => <Ico size={size}><path d="M15 6l-6 6 6 6"/></Ico>;

const TAB_ICONS: Record<MainTab, ({ size }: { size?: number }) => JSX.Element> = {
  attendance: IcoClock,
  barcode:    IcoBarcode,
  employees:  IcoUsers,
  history:    IcoHistory,
  settings:   IcoSettings,
};

const NAV_SECTIONS: { label: string; tabs: MainTab[] }[] = [
  { label: '打卡作業', tabs: ['attendance', 'barcode'] },
  { label: '人員管理', tabs: ['employees', 'history'] },
  { label: '系統',     tabs: ['settings'] },
];

// ── 圖示按鈕 ──────────────────────────────────────────────────────────
function IconBtn({
  onClick, title, children,
}: { onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button onClick={onClick} title={title} style={{
      width: 34, height: 34, borderRadius: 10,
      display: 'grid', placeItems: 'center',
      background: 'transparent', border: 'none', cursor: 'pointer',
      color: 'var(--ink-2)', transition: 'background 160ms, color 160ms',
      fontFamily: 'var(--font-kai)',
    }}
    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(107,142,127,0.1)')}
    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      {children}
    </button>
  );
}

// ── 主殼層 ────────────────────────────────────────────────────────────
export function AppShell({
  activeTab,
  barcodeEnabled,
  children,
  appTitle = '員工薪資計算系統',
  appVersion = '',
}: {
  activeTab: MainTab;
  barcodeEnabled: boolean;
  children: ReactNode;
  appTitle?: string;
  appVersion?: string;
}) {
  const [location, setLocation] = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('kq.collapsed') === '1');
  const [hidden,    setHidden]    = useState(() => localStorage.getItem('kq.hidden')    === '1');

  useEffect(() => { localStorage.setItem('kq.collapsed', collapsed ? '1' : '0'); }, [collapsed]);
  useEffect(() => { localStorage.setItem('kq.hidden',    hidden    ? '1' : '0'); }, [hidden]);

  const resolvedTab = getMainTabForPath(location) ?? activeTab;
  const navItems = barcodeEnabled
    ? MAIN_NAV_ITEMS
    : MAIN_NAV_ITEMS.filter(i => i.tab !== 'barcode');

  // 預載其他分頁
  useEffect(() => {
    const scheduler = getIdleScheduler();
    const handle = scheduler.schedule(() => {
      navItems.forEach(item => {
        if (item.tab !== resolvedTab) void preloadMainTab(item.tab);
      });
    });
    return () => scheduler.cancel(handle);
  }, [navItems, resolvedTab]);

  const sideW = hidden ? 0 : collapsed ? 64 : 248;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--paper)' }}>

      {/* ══ 側邊欄 ════════════════════════════════════════════════════ */}
      <aside style={{
        width: sideW, minWidth: sideW,
        height: '100vh', position: 'sticky', top: 0,
        background: 'var(--paper-soft)',
        borderRight: hidden ? 'none' : '1px solid var(--line)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width 300ms cubic-bezier(0.22,1,0.36,1), min-width 300ms cubic-bezier(0.22,1,0.36,1)',
        flexShrink: 0, zIndex: 20,
      }}>
        {/* 品牌 */}
        <div style={{
          padding: collapsed ? '18px 0 14px' : '18px 20px 14px',
          display: 'flex', alignItems: 'center',
          gap: 10, borderBottom: '1px solid var(--line-soft)',
          minHeight: 62, justifyContent: collapsed ? 'center' : 'flex-start',
        }}>
          <div style={{
            width: 34, height: 34, borderRadius: 8, flexShrink: 0,
            background: 'linear-gradient(145deg, var(--sage) 0%, var(--sage-deep) 100%)',
            color: '#FBFAF6', display: 'grid', placeItems: 'center',
            fontSize: 20, fontFamily: 'var(--font-kai)',
            boxShadow: '0 2px 6px rgba(79,115,101,0.3)',
          }}>勤</div>
          {!collapsed && (
            <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', whiteSpace: 'nowrap' }}>
              <span style={{ fontSize: 16, fontWeight: 500, color: 'var(--ink-1)', letterSpacing: '0.06em' }}>考勤薪資</span>
              <span style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '0.12em' }}>BARCODE · V3</span>
            </div>
          )}
        </div>

        {/* 導覽 */}
        <nav style={{ padding: '14px 10px', flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
          {NAV_SECTIONS.map(sec => (
            <div key={sec.label}>
              {collapsed
                ? <div style={{ height: 1, background: 'var(--line)', margin: '10px 12px' }} />
                : <div style={{ padding: '14px 12px 6px', fontSize: 11, color: 'var(--ink-3)', letterSpacing: '0.2em', fontWeight: 500 }}>{sec.label}</div>
              }
              {sec.tabs
                .filter(tab => barcodeEnabled || tab !== 'barcode')
                .map(tab => {
                  const item = navItems.find(n => n.tab === tab);
                  if (!item) return null;
                  const Icon = TAB_ICONS[tab];
                  const isActive = resolvedTab === tab;
                  return (
                    <button key={tab} title={item.label}
                      onClick={() => { if (!isActive) setLocation(getPathForMainTab(tab)); }}
                      onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'rgba(107,142,127,0.08)'; }}
                      onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = isActive ? 'var(--paper)' : 'transparent'; }}
                      style={{
                        display: 'flex', alignItems: 'center',
                        gap: collapsed ? 0 : 12,
                        padding: collapsed ? '10px 0' : '9px 12px',
                        justifyContent: collapsed ? 'center' : 'flex-start',
                        width: '100%', borderRadius: 10, marginBottom: 2,
                        background: isActive ? 'var(--paper)' : 'transparent',
                        color: isActive ? 'var(--sage-deep)' : 'var(--ink-2)',
                        fontWeight: isActive ? 500 : 400, fontSize: 14.5,
                        whiteSpace: 'nowrap', fontFamily: 'var(--font-kai)',
                        border: isActive ? '1px solid var(--line-soft)' : '1px solid transparent',
                        boxShadow: isActive ? '0 1px 2px rgba(42,46,42,0.05)' : 'none',
                        cursor: 'pointer', transition: 'all 160ms', position: 'relative',
                      }}>
                      {isActive && !collapsed && (
                        <span style={{
                          position: 'absolute', left: -10, top: '50%', transform: 'translateY(-50%)',
                          width: 3, height: 20, borderRadius: '0 3px 3px 0', background: 'var(--sage)',
                        }} />
                      )}
                      <span style={{ color: isActive ? 'var(--sage)' : 'var(--ink-3)', flexShrink: 0 }}>
                        <Icon size={20} />
                      </span>
                      {!collapsed && <span>{item.label}</span>}
                    </button>
                  );
              })}
            </div>
          ))}
        </nav>

        {/* 用戶資訊 */}
        <div style={{ padding: 12, borderTop: '1px solid var(--line-soft)' }}>
          <div style={{
            display: 'flex', alignItems: 'center',
            gap: collapsed ? 0 : 10, justifyContent: collapsed ? 'center' : 'flex-start',
            padding: '8px 10px', borderRadius: 10,
          }}>
            <div style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              background: 'linear-gradient(135deg, #7A9AB3 0%, #6B8E7F 100%)',
              color: '#fff', display: 'grid', placeItems: 'center', fontSize: 13,
            }}>管</div>
            {!collapsed && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 13.5, color: 'var(--ink-1)' }}>管理員</span>
                <span style={{ fontSize: 11, color: 'var(--ink-3)', letterSpacing: '0.1em' }}>已登入</span>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* ══ 主內容區 ══════════════════════════════════════════════════ */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

        {/* 頂欄 */}
        <header style={{
          height: 62, padding: '0 26px',
          display: 'flex', alignItems: 'center', gap: 12,
          borderBottom: '1px solid var(--line-soft)',
          background: 'rgba(251,250,246,0.88)',
          backdropFilter: 'blur(8px)',
          position: 'sticky', top: 0, zIndex: 10,
        }}>
          {/* 完全隱藏／顯示 側邊欄 */}
          <IconBtn onClick={() => setHidden(h => !h)} title={hidden ? '顯示側邊欄' : '完全隱藏側邊欄'}>
            {hidden ? <IcoChevronR size={20} /> : <IcoSidebar size={20} />}
          </IconBtn>
          {/* 收合 */}
          {!hidden && (
            <IconBtn onClick={() => setCollapsed(c => !c)} title={collapsed ? '展開側邊欄' : '收合為圖示'}>
              {collapsed ? <IcoChevronR size={18} /> : <IcoChevronL size={18} />}
            </IconBtn>
          )}

          {/* 麵包屑 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--ink-2)' }}>
            <span>{appTitle}</span>
            <span style={{ color: 'var(--ink-4)' }}>／</span>
            <span style={{ color: 'var(--ink-1)', fontWeight: 500 }}>
              {navItems.find(n => n.tab === resolvedTab)?.label ?? ''}
            </span>
          </div>

          <div style={{ flex: 1 }} />

          {/* 版本 */}
          {appVersion && (
            <span style={{ fontSize: 12, color: 'var(--ink-3)', letterSpacing: '0.12em' }}>
              v{appVersion}
            </span>
          )}
        </header>

        {/* 頁面內容 */}
        <main style={{ flex: 1, padding: '30px 38px 48px', overflowY: 'auto' }}>
          {children}
        </main>

        {/* Footer */}
        <footer style={{
          borderTop: '1px solid var(--line-soft)', background: 'var(--paper-soft)',
          padding: '12px 26px', textAlign: 'center',
          fontSize: 12, color: 'var(--ink-3)', letterSpacing: '0.1em',
        }}>
          {appTitle} &copy; {new Date().getFullYear()}
          {appVersion && ` 版本 ${appVersion}`}
        </footer>
      </div>
    </div>
  );
}
