import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** No DATABASE_URL fallback, .env loading, URL options or non-loopback targets. */
export function payrollTestDatabaseUrl(env = process.env) {
  if (env.PAYROLL_CORRECTION_TEST_DB_DISPOSABLE !== '1') {
    throw new Error('Set PAYROLL_CORRECTION_TEST_DB_DISPOSABLE=1 for a fresh disposable test database.');
  }
  let url;
  try {
    url = new URL(env.PAYROLL_CORRECTION_TEST_DB_URL ?? '');
  } catch {
    throw new Error('An explicit PAYROLL_CORRECTION_TEST_DB_URL is required.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '::1'].includes(host) ||
      !/^payroll_test_[a-z0-9_]+$/.test(database) ||
      !url.username || url.search || url.hash ||
      (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))) {
    throw new Error('The payroll test database must use loopback, a payroll_test_* name and no URL options.');
  }
  return url.toString();
}

export function payrollTestReporterArgs(args = []) {
  // Never allow a forwarded config/filter to activate another real-database suite.
  if (args.some(arg => !/^--reporter=(?:default|verbose|json)$/.test(arg) &&
      !/^--outputFile=[^\0\r\n]+\.json$/.test(arg))) {
    throw new Error('Only --reporter=default|verbose|json and --outputFile=*.json are supported.');
  }
  return args;
}

function isolatedEnvironment(url, runtimeDir) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC',
    'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'CI', 'NO_COLOR', 'FORCE_COLOR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return Object.assign(env, {
    NODE_ENV: 'test', LOG_LEVEL: 'error',
    PAYROLL_CORRECTION_TEST_DB_URL: url,
    PAYROLL_CORRECTION_TEST_DB_DISPOSABLE: '1',
    DATABASE_URL: url,
    APP_RUNTIME_DIR: runtimeDir,
    APP_LOG_DIR: path.join(runtimeDir, 'logs'),
    APP_BACKUP_DIR: path.join(runtimeDir, 'backups'),
  });
}

export async function runPayrollDatabaseTests() {
  const url = payrollTestDatabaseUrl();
  const reporterArgs = payrollTestReporterArgs(process.argv.slice(2));
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'payroll-correction-test-'));
  const env = isolatedEnvironment(url, runtimeDir);
  const connection = postgres(url, { ssl: false, max: 1, onnotice: () => {} });
  try {
    const [target] = await connection`select current_database() as name,
      host(inet_server_addr()) as address,
      pg_try_advisory_lock(2146, 202610) as locked`;
    const expectedName = decodeURIComponent(new URL(url).pathname.slice(1));
    if (target.name !== expectedName || !['127.0.0.1', '::1'].includes(target.address) || !target.locked) {
      throw new Error('The server target is not the unlocked loopback scratch database.');
    }
    const [{ count }] = await connection`select count(*)::int as count from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p','v','m','S')`;
    if (count !== 0) {
      throw new Error('Use a fresh test database with an empty public schema; existing tables are never reset.');
    }
    const generated = spawnSync(process.execPath, [path.join(root, 'node_modules/drizzle-kit/bin.cjs'),
      'export', '--dialect', 'postgresql', '--schema', './shared/schema.ts'],
    { cwd: root, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (generated.status !== 0 || !generated.stdout.trim().startsWith('CREATE TABLE')) {
      throw new Error('Could not export the current schema for the scratch database.');
    }
    await connection.begin(async tx => {
      await tx.unsafe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      await tx.unsafe(generated.stdout);
    });
    await connection.unsafe(await readFile(path.join(root, 'payroll_corrections_schema.sql'), 'utf8'));
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'),
      'run', '--config', 'vitest.payroll-real-db.config.ts', ...reporterArgs],
    { cwd: root, env, stdio: 'inherit' });
    return result.status ?? 1;
  } finally {
    await connection.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await runPayrollDatabaseTests();
  } catch {
    // Database/driver exceptions can contain connection parameters. Do not print them.
    console.error('Payroll database tests refused or could not initialize the fresh loopback scratch database.');
    process.exitCode = 1;
  }
}
