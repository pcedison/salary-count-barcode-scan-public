import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { assertExternalDatabaseTlsUrl } from '../../shared/databaseTls.mjs';

describe('external PostgreSQL TLS URL guard', () => {
  it.each(['sslmode=no-verify', 'sslmode=disable', 'sslmode=require', 'sslmode=verify-ca', 'ssl=false', 'sslrootcert=local.pem', 'sslcert=local.pem', 'sslkey=local.key', 'uselibpqcompat=true', 'SSLMODE=disable', 'sslmode=verify-full&sslmode=disable'])('rejects the override %s without opening a connection', query => {
    expect(() => assertExternalDatabaseTlsUrl(`postgres://fixture:fake@invalid.example/test?${query}`)).toThrow('TLS');
  });
  it.each(['', '?sslmode=verify-full'])('retains certificate verification in pg for safe URL %s', suffix => {
    const url = `postgres://fixture:fake@invalid.example/test${suffix}`;
    assertExternalDatabaseTlsUrl(url);
    const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
    const ssl = (client as any).connectionParameters.ssl;
    expect(ssl).not.toBe(false);
    expect(ssl.rejectUnauthorized).not.toBe(false);
  });
  it('preserves explicitly isolated loopback test connections', () => {
    expect(() => assertExternalDatabaseTlsUrl('postgres://fixture:fake@127.0.0.1:9/test?sslmode=disable')).not.toThrow();
  });
  it.each(['host=invalid.example', 'HOST=invalid.example', 'hostaddr=192.0.2.1', 'port=5433', 'user=other', 'password=other', 'database=other'])('rejects connection query override %s before the loopback exception', query => {
    expect(() => assertExternalDatabaseTlsUrl(`postgres://fixture:fake@localhost/test?${query}&sslmode=disable`)).toThrow('connection target');
  });
});
