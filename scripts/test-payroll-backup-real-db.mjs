import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { payrollTestDatabaseUrl, payrollTestReporterArgs } from './test-payroll-real-db.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Optional Docker fixture proof; never treat an arbitrary private IP as local. */
export function verifyPayrollBackupDockerTarget(url, manifest, inspect = spawnSync) {
  if (!manifest || !/^[a-f0-9]{64}$/.test(manifest.id) || manifest.owner !== 'attendance20261029' ||
    manifest.host !== '127.0.0.1' || !Number.isInteger(manifest.port) || manifest.hostDataMounts !== false ||
    !/^sha256:[a-f0-9]{64}$/.test(manifest.image) || typeof manifest.createdAt !== 'string') throw new Error('Invalid owned Docker fixture manifest.');
  const target = new URL(url);
  if (target.hostname !== manifest.host || Number(target.port) !== manifest.port) throw new Error('Fixture port does not match the test URL.');
  const format = '{"id":{{json .Id}},"owner":{{json (index .Config.Labels "owner")}},"purpose":{{json (index .Config.Labels "purpose")}},"image":{{json .Image}},"createdAt":{{json .Created}},"running":{{json .State.Running}},"networks":{{json .NetworkSettings.Networks}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}}}';
  // This format deliberately omits Config.Env and any database credentials.
  const result = inspect('docker', ['inspect', '--format', format, manifest.id], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024 });
  if (result.status !== 0) throw new Error('Cannot verify the owned Docker fixture.');
  let actual;
  try { actual = JSON.parse(result.stdout); } catch { throw new Error('Invalid Docker identity response.'); }
  const bindings = actual.ports?.['5432/tcp'];
  const networks = Object.values(actual.networks ?? {});
  if (actual.id !== manifest.id || actual.owner !== manifest.owner || actual.purpose !== 'isolated-verification' ||
    actual.image !== manifest.image || actual.createdAt !== manifest.createdAt || actual.running !== true ||
    Object.keys(actual.ports ?? {}).length !== 1 || !Array.isArray(bindings) || bindings.length !== 1 ||
    bindings[0].HostIp !== manifest.host || Number(bindings[0].HostPort) !== manifest.port ||
    !Array.isArray(actual.mounts) || actual.mounts.some(mount => mount.Type !== 'tmpfs') ||
    !actual.tmpfs?.['/var/lib/postgresql/data'] || networks.length === 0 || networks.some(network =>
      typeof network.IPAddress !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(network.IPAddress))) {
    throw new Error('Docker fixture ownership, network or disposable storage did not match.');
  }
  return [...new Set(networks.map(network => network.IPAddress))];
}

export async function runPayrollBackupDatabaseTests() {
  const url = payrollTestDatabaseUrl();
  const reporterArgs = payrollTestReporterArgs(process.argv.slice(2));
  const freshUrl = new URL(url);
  freshUrl.pathname += '_fresh';
  payrollTestDatabaseUrl({ PAYROLL_CORRECTION_TEST_DB_URL: freshUrl.toString(),
    PAYROLL_CORRECTION_TEST_DB_DISPOSABLE: '1' });
  const manifestPath = process.env.PAYROLL_BACKUP_TEST_DOCKER_MANIFEST;
  const dockerAddress = manifestPath
    ? verifyPayrollBackupDockerTarget(url, JSON.parse(await readFile(manifestPath, 'utf8')))
    : [];
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'payroll-backup-test-'));
  // Do not inherit production credentials, integrations, .env or database options.
  const env = {};
  for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC',
    'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'CI', 'NO_COLOR', 'FORCE_COLOR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { NODE_ENV: 'test', LOG_LEVEL: 'error', DATABASE_URL: url,
    PAYROLL_CORRECTION_TEST_DB_URL: url, PAYROLL_CORRECTION_TEST_DB_DISPOSABLE: '1',
    PAYROLL_BACKUP_FRESH_DB_URL: freshUrl.toString(), APP_RUNTIME_DIR: runtimeDir,
    APP_LOG_DIR: path.join(runtimeDir, 'logs'), APP_BACKUP_DIR: path.join(runtimeDir, 'backups') });
  if (manifestPath) env.PAYROLL_BACKUP_TEST_DOCKER_MANIFEST = path.resolve(manifestPath);
  const primary = postgres(url, { ssl: false, max: 1, onnotice: () => {} });
  const admin = postgres(adminUrl.toString(), { ssl: false, max: 1, onnotice: () => {} });
  let fresh;
  try {
    const [target] = await primary`select current_database() as name,
      host(inet_server_addr()) as address, pg_try_advisory_lock(2146, 202611) as locked`;
    if (target.name !== decodeURIComponent(new URL(url).pathname.slice(1)) ||
      !['127.0.0.1', '::1', ...dockerAddress].includes(target.address) || !target.locked) {
      throw new Error('The target is not the unlocked loopback scratch database.');
    }
    const [{ count }] = await primary`select count(*)::int as count from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p','v','m','S')`;
    if (count !== 0) throw new Error('Existing tables are never reset; use a fresh empty database.');
    const freshName = decodeURIComponent(freshUrl.pathname.slice(1));
    const [{ exists }] = await admin`select exists(select 1 from pg_database where datname=${freshName}) as exists`;
    if (exists) throw new Error('The second scratch database already exists; it is never reused or reset.');
    await admin.unsafe(`CREATE DATABASE "${freshName}"`);
    fresh = postgres(freshUrl.toString(), { ssl: false, max: 1, onnotice: () => {} });
    const generated = spawnSync(process.execPath, [path.join(root, 'node_modules/drizzle-kit/bin.cjs'),
      'export', '--dialect', 'postgresql', '--schema', './shared/schema.ts'],
    { cwd: root, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (generated.status !== 0 || !generated.stdout.trim().startsWith('CREATE TABLE')) {
      throw new Error('Could not export the current schema.');
    }
    const migration = await readFile(path.join(root, 'payroll_corrections_schema.sql'), 'utf8');
    for (const connection of [primary, fresh]) {
      await connection.begin(async tx => {
        await tx.unsafe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
        await tx.unsafe(generated.stdout);
      });
      await connection.unsafe(migration);
    }
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'),
      'run', '--config', 'vitest.payroll-backup-real-db.config.ts', ...reporterArgs],
    { cwd: root, env, stdio: 'inherit' });
    return result.status ?? 1;
  } finally {
    await Promise.all([primary.end({ timeout: 5 }), admin.end({ timeout: 5 }), fresh?.end({ timeout: 5 })]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await runPayrollBackupDatabaseTests(); }
  catch {
    // Driver errors may embed connection parameters. Keep them out of output.
    console.error('Payroll backup tests refused or could not initialize fresh loopback scratch databases.');
    process.exitCode = 1;
  }
}
