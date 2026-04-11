import { describe, expect, it } from 'vitest';

import {
  MAIN_NAV_ITEMS,
  getMainTabForPath,
  getPathForMainTab,
  normalizeMainPath
} from './appNavigation';

describe('app navigation', () => {
  it('normalizes main paths before tab lookup', () => {
    expect(normalizeMainPath('/')).toBe('/');
    expect(normalizeMainPath('/history/')).toBe('/history');
    expect(normalizeMainPath('/settings?foo=bar')).toBe('/settings');
    expect(normalizeMainPath('/employees#section')).toBe('/employees');
  });

  it('maps direct routes to the expected active tab', () => {
    expect(getMainTabForPath('/')).toBe('attendance');
    expect(getMainTabForPath('/barcode')).toBe('barcode');
    expect(getMainTabForPath('/employees/')).toBe('employees');
    expect(getMainTabForPath('/history?month=2026-03')).toBe('history');
    expect(getMainTabForPath('/settings#pin')).toBe('settings');
    expect(getMainTabForPath('/print-salary')).toBeNull();
  });

  it('keeps one canonical path per main tab', () => {
    const uniquePaths = new Set(MAIN_NAV_ITEMS.map((item) => item.path));

    expect(uniquePaths.size).toBe(MAIN_NAV_ITEMS.length);
    expect(getPathForMainTab('attendance')).toBe('/');
    expect(getPathForMainTab('settings')).toBe('/settings');
  });
});
