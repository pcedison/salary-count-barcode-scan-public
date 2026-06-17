import { describe, expect, it } from 'vitest';

import {
  diffSpecialLeaveDates,
  matchesYearMonth,
  normalizeDateToDash,
  normalizeDateToSlash,
  parseYearMonthKey,
  removeSpecialLeaveDate
} from './specialLeaveSync';

describe('specialLeaveSync', () => {
  it('normalizes dates to dash format', () => {
    expect(normalizeDateToDash('2025/03/12')).toBe('2025-03-12');
    expect(normalizeDateToDash('2025-03-12')).toBe('2025-03-12');
  });

  it('normalizes dates to slash format', () => {
    expect(normalizeDateToSlash('2025-03-12')).toBe('2025/03/12');
    expect(normalizeDateToSlash('2025/03/12')).toBe('2025/03/12');
  });

  it('detects added and removed special leave dates across mixed separators', () => {
    expect(
      diffSpecialLeaveDates(
        ['2025/03/10', '2025-03-12'],
        ['2025-03-12', '2025/03/15']
      )
    ).toEqual({
      addedDates: ['2025-03-15'],
      removedDates: ['2025-03-10']
    });
  });

  it('removes a deleted holiday date regardless of separator format', () => {
    expect(
      removeSpecialLeaveDate(
        ['2025/03/10', '2025-03-12', '2025/03/15'],
        '2025-03-12'
      )
    ).toEqual(['2025/03/10', '2025/03/15']);
  });

  it('matches special leave cash months across common month formats', () => {
    expect(parseYearMonthKey('2026年6月')).toBe('2026-06');
    expect(parseYearMonthKey('2026-06')).toBe('2026-06');
    expect(parseYearMonthKey('2026/6')).toBe('2026-06');
    expect(parseYearMonthKey('202606')).toBe('2026-06');
    expect(matchesYearMonth('2026年6月', 2026, 6)).toBe(true);
    expect(matchesYearMonth('2026年7月', 2026, 6)).toBe(false);
  });
});
