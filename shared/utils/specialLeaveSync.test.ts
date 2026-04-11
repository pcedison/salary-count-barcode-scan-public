import { describe, expect, it } from 'vitest';

import {
  diffSpecialLeaveDates,
  normalizeDateToDash,
  normalizeDateToSlash,
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
});
