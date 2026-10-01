import { describe, expect, it } from 'vitest';
import { validateAuthInvalidationCommand } from './invalidate-restored-admin-sessions';

describe('external restore administrator invalidation guards', () => {
  const valid = { DATABASE_URL: 'postgres://synthetic@127.0.0.1/payroll_test_auth', PAYROLL_WRITES_PAUSED: 'true' };

  it.each([[], ['--confirm', '--extra'], ['--yes']])('rejects incomplete or ambiguous explicit confirmation %#', args => {
    expect(() => validateAuthInvalidationCommand(args, valid)).toThrow('AUTH_INVALIDATION_CONFIRMATION_REQUIRED');
  });

  it.each([undefined, '', 'false', '0', '1', 'paused'])('requires the explicit true maintenance value %#', value => {
    expect(() => validateAuthInvalidationCommand(['--confirm'], { ...valid, PAYROLL_WRITES_PAUSED: value }))
      .toThrow('AUTH_INVALIDATION_MAINTENANCE_REQUIRED');
  });

  it('rejects an absent explicit database without reading environment files', () => {
    expect(() => validateAuthInvalidationCommand(['--confirm'], { PAYROLL_WRITES_PAUSED: 'true' }))
      .toThrow('AUTH_INVALIDATION_DATABASE_REQUIRED');
  });

  it.each(['invalid', 'https://example.com/db', 'postgres://127.0.0.1/test', 'postgres://user@127.0.0.1/'])
    ('rejects malformed or incomplete database targets %#', value => {
      expect(() => validateAuthInvalidationCommand(['--confirm'], { ...valid, DATABASE_URL: value }))
        .toThrow('AUTH_INVALIDATION_INVALID_TARGET');
    });

  it('accepts an explicitly confirmed target only with maintenance active', () => {
    expect(() => validateAuthInvalidationCommand(['--confirm'], valid)).not.toThrow();
  });
});
