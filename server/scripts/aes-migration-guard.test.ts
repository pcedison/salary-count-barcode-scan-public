import { describe, expect, it } from 'vitest';

import {
  describeDatabaseTarget,
  resolveAesMigrationOperator,
  validateAesMutationRequest
} from '../../scripts/lib/aes-migration-guard.mjs';

describe('aes migration guard', () => {
  it('detects remote database targets and preserves local ones', () => {
    expect(describeDatabaseTarget('postgresql://user:pass@localhost:5432/app')).toEqual({
      host: 'localhost',
      database: 'app',
      isRemote: false
    });

    expect(
      describeDatabaseTarget('postgresql://user:pass@db.internal.test:6543/postgres')
    ).toEqual({
      host: 'db.internal.test',
      database: 'postgres',
      isRemote: true
    });
  });

  it('normalizes operator identity from CLI or env input', () => {
    expect(resolveAesMigrationOperator('  Marcus  ')).toBe('Marcus');
    expect(resolveAesMigrationOperator('', '  Ops Window  ')).toBe('Ops Window');
    expect(resolveAesMigrationOperator('   ', '   ')).toBeNull();
  });

  it('blocks execute when remote approval or execute prerequisites are missing', () => {
    expect(() =>
      validateAesMutationRequest({
        mode: 'execute',
        databaseUrl: 'postgresql://user:pass@db.internal.test:6543/postgres',
        allowRemote: false,
        operator: 'Marcus',
        useAesEncryption: true,
        encryptionSaltConfigured: true
      })
    ).toThrow(/--allow-remote/);

    expect(() =>
      validateAesMutationRequest({
        mode: 'execute',
        databaseUrl: 'postgresql://user:pass@localhost:5432/app',
        allowRemote: true,
        operator: null,
        useAesEncryption: true,
        encryptionSaltConfigured: true
      })
    ).toThrow(/Operator identity is required/);

    expect(() =>
      validateAesMutationRequest({
        mode: 'execute',
        databaseUrl: 'postgresql://user:pass@localhost:5432/app',
        allowRemote: true,
        operator: 'Marcus',
        useAesEncryption: false,
        encryptionSaltConfigured: true
      })
    ).toThrow(/USE_AES_ENCRYPTION=true/);

    expect(() =>
      validateAesMutationRequest({
        mode: 'execute',
        databaseUrl: 'postgresql://user:pass@localhost:5432/app',
        allowRemote: true,
        operator: 'Marcus',
        useAesEncryption: true,
        encryptionSaltConfigured: false
      })
    ).toThrow(/ENCRYPTION_SALT/);
  });

  it('allows approved rollback against remote targets and execute when all gates are green', () => {
    expect(
      validateAesMutationRequest({
        mode: 'rollback',
        databaseUrl: 'postgresql://user:pass@db.internal.test:6543/postgres',
        allowRemote: true
      })
    ).toMatchObject({
      target: {
        host: 'db.internal.test',
        database: 'postgres',
        isRemote: true
      }
    });

    expect(
      validateAesMutationRequest({
        mode: 'execute',
        databaseUrl: 'postgresql://user:pass@localhost:5432/app',
        allowRemote: true,
        operator: 'Marcus',
        useAesEncryption: true,
        encryptionSaltConfigured: true
      })
    ).toMatchObject({
      operator: 'Marcus',
      target: {
        host: 'localhost',
        database: 'app',
        isRemote: false
      }
    });
  });
});
