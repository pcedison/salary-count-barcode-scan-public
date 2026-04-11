import { describe, expect, it } from 'vitest';

import { extractListData } from './paginatedPayload';

describe('extractListData', () => {
  it('returns arrays unchanged', () => {
    expect(extractListData([{ id: 1 }])).toEqual([{ id: 1 }]);
  });

  it('unwraps paginated payloads', () => {
    expect(
      extractListData({
        data: [{ id: 2 }],
        pagination: { page: 1, limit: 50, total: 1, pages: 1 }
      })
    ).toEqual([{ id: 2 }]);
  });

  it('returns an empty array for nullish payloads', () => {
    expect(extractListData(null)).toEqual([]);
    expect(extractListData(undefined)).toEqual([]);
  });
});
