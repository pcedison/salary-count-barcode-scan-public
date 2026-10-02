// Synthetic loopback benchmark. Never loads .env or falls back to DATABASE_URL.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { payrollTestDatabaseUrl } from './test-payroll-real-db.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let connection;
try {
  const url = payrollTestDatabaseUrl();
  if (process.argv.length !== 2) throw new Error('No command-line overrides supported.');
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'payroll-benchmark-'));
  const env = {};
  for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC',
    'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'CI', 'NO_COLOR', 'FORCE_COLOR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    NODE_ENV: 'test', LOG_LEVEL: 'error', DATABASE_URL: url,
    PAYROLL_CORRECTION_TEST_DB_URL: url, PAYROLL_CORRECTION_TEST_DB_DISPOSABLE: '1',
    APP_RUNTIME_DIR: runtime, APP_LOG_DIR: path.join(runtime, 'logs'),
    APP_BACKUP_DIR: path.join(runtime, 'backups'), PAYROLL_BENCHMARK_CHILD: '1',
  });
  connection = postgres(url, { ssl: false, max: 1, onnotice: () => {} });
  const [target] = await connection`select current_database() as name,
    host(inet_server_addr()) as address, pg_try_advisory_lock(2146, 202612) as locked`;
  if (target.name !== decodeURIComponent(new URL(url).pathname.slice(1)) ||
    !['127.0.0.1', '::1'].includes(target.address) || !target.locked) {
    throw new Error('Wrong target or benchmark already running.');
  }
  const [{ count }] = await connection`select count(*)::int as count from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p','v','m','S')`;
  if (count !== 0) throw new Error('Only fresh empty databases are accepted.');
  const exported = spawnSync(process.execPath, [path.join(root, 'node_modules/drizzle-kit/bin.cjs'),
    'export', '--dialect', 'postgresql', '--schema', './shared/schema.ts'],
  { cwd: root, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (exported.status !== 0 || !exported.stdout.trim().startsWith('CREATE TABLE')) {
    throw new Error('Schema export failed.');
  }
  await connection.begin(async tx => {
    await tx.unsafe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await tx.unsafe(exported.stdout);
  });
  await connection.unsafe(await readFile(path.join(root, 'payroll_corrections_schema.sql'), 'utf8'));
  await mkdir(path.join(root, 'tmp/performance'), { recursive: true });
  const result = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx',
    path.join(root, 'scripts/benchmark-payroll-worker.ts')],
  { cwd: root, env, stdio: 'inherit', windowsHide: true });
  process.exitCode = result.status ?? 1;
} catch {
  // Database exception messages can contain connection parameters.
  console.error('Benchmark refused or failed; requires a fresh explicit loopback payroll_test_* database.');
  process.exitCode = 1;
} finally {
  await connection?.end({ timeout: 5 });
}
