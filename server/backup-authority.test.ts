import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from '@shared/schema';
import { AUTHORITATIVE_TABLE_NAMES, EXCLUDED_TABLE_NAMES } from './backup-authority';

describe('backup coverage for the current database schema', () => {
  it('classifies every declared table explicitly, so newly added audit tables cannot silently vanish', () => {
    const declared = Object.values(schema).filter(value => is(value, PgTable)).map(table => getTableName(table));
    // connect-pg-simple owns this optional runtime table outside Drizzle schema.
    declared.push('user_sessions');
    const classified = [...AUTHORITATIVE_TABLE_NAMES, ...EXCLUDED_TABLE_NAMES];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual([...declared].sort());
  });
});
