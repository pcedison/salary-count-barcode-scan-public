export type MainTab = 'attendance' | 'barcode' | 'employees' | 'history' | 'settings';

export interface MainNavItem {
  tab: MainTab;
  path: string;
  label: string;
}

export const MAIN_NAV_ITEMS: MainNavItem[] = [
  { tab: 'attendance', path: '/', label: '考勤登記' },
  { tab: 'barcode', path: '/barcode', label: '條碼掃描打卡' },
  { tab: 'employees', path: '/employees', label: '員工管理' },
  { tab: 'history', path: '/history', label: '歷史紀錄' },
  { tab: 'settings', path: '/settings', label: '系統設定' }
];

export function normalizeMainPath(pathname: string): string {
  const cleanPath = pathname.split(/[?#]/, 1)[0] || '/';

  if (cleanPath === '/') {
    return cleanPath;
  }

  return cleanPath.endsWith('/') ? cleanPath.slice(0, -1) : cleanPath;
}

export function getMainTabForPath(pathname: string): MainTab | null {
  const normalizedPath = normalizeMainPath(pathname);
  const matchedItem = MAIN_NAV_ITEMS.find((item) => item.path === normalizedPath);

  return matchedItem?.tab ?? null;
}

export function getPathForMainTab(tab: MainTab): string {
  const matchedItem = MAIN_NAV_ITEMS.find((item) => item.tab === tab);

  if (!matchedItem) {
    throw new Error(`Unknown main tab: ${tab}`);
  }

  return matchedItem.path;
}
