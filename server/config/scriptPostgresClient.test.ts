import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPostgresClient } from '../../scripts/lib/postgres-client.mjs';

afterEach(() => vi.unstubAllEnvs());

describe('operator script PostgreSQL TLS policy without network access', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('supports isolated loopback PostgreSQL at %s', async host => {
    const client = createPostgresClient(`postgresql://synthetic@${host}:5432/payroll_test_tls`);
    expect(client.options.host).toEqual([host.replace(/^\[|\]$/g, '')]);
    expect(client.options.ssl).toBe(false);
    await client.end();
  });

  it.each(['db.example.test', 'example.pooler.supabase.com'])('validates external certificates by default at %s', async host => {
    vi.stubEnv('PGSSLREJECT_UNAUTHORIZED', 'true');
    const client = createPostgresClient(`postgresql://synthetic@${host}/synthetic`);
    expect(client.options.ssl).toEqual({ rejectUnauthorized: true });
    await client.end();
  });

  it('does not let a URL option silently disable external TLS', async () => {
    vi.stubEnv('PGSSLREJECT_UNAUTHORIZED', 'true');
    const client = createPostgresClient('postgresql://synthetic@db.example.test/synthetic?sslmode=disable');
    expect(client.options.ssl).toEqual({ rejectUnauthorized: true });
    await client.end();
  });

  it('requires explicit configuration for the known pooler exception and keeps transaction pooling compatibility', async () => {
    vi.stubEnv('PGSSLREJECT_UNAUTHORIZED', 'false');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const client = createPostgresClient('postgresql://synthetic@example.pooler.supabase.com:6543/synthetic');
      expect(client.options.ssl).toEqual({ rejectUnauthorized: false });
      expect(client.options.prepare).toBe(false);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('certificate validation is disabled'));
      await client.end();
    } finally { warning.mockRestore(); }
  });

  it.each(['db.example.test', 'pooler.supabase.com.attacker.test'])('rejects certificate bypass for unapproved host %s', host => {
    vi.stubEnv('PGSSLREJECT_UNAUTHORIZED', 'false');
    expect(() => createPostgresClient(`postgresql://synthetic@${host}/synthetic`))
      .toThrow('known Supabase pooler');
  });

  it('rejects malformed input with a fixed message instead of echoing it', () => {
    expect(() => createPostgresClient('synthetic-private-marker-not-a-url'))
      .toThrow(/^Invalid PostgreSQL connection configuration\.$/);
  });

  it.each([
    'unapproved.example.test,example.pooler.supabase.com',
    'unapproved.example.test%2cexample.pooler.supabase.com',
    '127.0.0.1,example.pooler.supabase.com',
  ])('rejects multi-host or encoded host lists before applying the TLS exception: %s', host => {
    vi.stubEnv('PGSSLREJECT_UNAUTHORIZED', 'false');
    expect(() => createPostgresClient(`postgresql://synthetic@${host}/synthetic`))
      .toThrow(/^Invalid PostgreSQL connection configuration\.$/);
  });
});
