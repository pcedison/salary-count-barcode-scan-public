// Run through benchmark-payroll.mjs. All fixtures are generated, never imported.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import express from 'express';
import { payrollTestDatabaseUrl } from './test-payroll-real-db.mjs';

let closeDatabase: (() => Promise<void>) | undefined;
async function runBenchmark() {
assert.equal(process.env.PAYROLL_BENCHMARK_CHILD, '1');
if (process.env.DATABASE_URL !== payrollTestDatabaseUrl()) {
  throw new Error('Benchmark database environment mismatch.');
}
const { sql } = await import('../server/db');
closeDatabase = async () => { await sql.end({ timeout: 5 }); };
const { salaryRepository } = await import('../server/repositories/salaryRepository');
const { storage } = await import('../server/storage');
const { registerSalaryRoutes } = await import('../server/routes/salary.routes');
const { registerAttendanceRoutes } = await import('../server/routes/attendance.routes');
const { PermissionLevel } = await import('../server/admin-auth');
const [target] = await sql`select current_database() as name, host(inet_server_addr()) as address,
  current_setting('server_version') as version`;
assert.equal(target.name, decodeURIComponent(new URL(payrollTestDatabaseUrl()).pathname.slice(1)));
assert.ok(['127.0.0.1', '::1'].includes(target.address));
for (const table of ['employees', 'salary_records', 'temporary_attendance']) {
  const [{ count }] = await sql.unsafe(`select count(*)::int as count from ${table}`);
  assert.equal(count, 0, 'Fresh empty application tables are required.');
}

const report: any = {
  schemaVersion: 1, recordedAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceFiles: {},
  configuration: {
    node: process.version, postgres: target.version, os: `${os.platform()} ${os.release()}`,
    cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, ramBytes: os.totalmem(),
    sizes: [100, 1000, 10000], warmup: 5, samples: 30, concurrency: 1,
    applicationPoolMax: sql.options.max, pageLimit: 50, daysPerSalarySnapshot: 22,
    database: target.name, databaseHost: target.address, databasePort: Number(new URL(payrollTestDatabaseUrl()).port),
    percentile: 'nearest-rank',
  },
  scope: 'Actual salary and attendance HTTP routes/repositories on loopback; synthetic admin session injected before requireAdmin. No server bootstrap, session store, reverse proxy, TLS, rate limits, browser rendering, PDF, email, backup or production traffic measured.',
  methodology: 'Seed/schema/ANALYZE and EXPLAIN run outside timing. Five warmups followed by 30 sequential samples per operation. HTTP includes fetch, response transfer and JSON parsing. Query counts from postgres debug callback; all timings include instrumentation. RSS/heap observations are application process only, not PostgreSQL memory.',
  datasets: [],
};
for (const filename of ['shared/schema.ts', 'server/db.ts', 'server/storage.ts',
  'server/repositories/salaryRepository.ts', 'server/routes/salary.routes.ts',
  'server/routes/attendance.routes.ts', 'scripts/benchmark-payroll.mjs', 'scripts/benchmark-payroll-worker.ts']) {
  report.sourceFiles[filename] = createHash('sha256').update(await readFile(filename)).digest('hex');
}
report.databaseSettings = await sql`select name, setting, unit from pg_settings
  where name in ('shared_buffers','work_mem','effective_cache_size','max_connections','fsync','synchronous_commit') order by name`;
const app = express();
// The only listening socket is ephemeral loopback. Never use this harness in the product.
app.use((req, _res, next) => {
  req.session = { adminAuth: { isAdmin: true, permissionLevel: PermissionLevel.SUPER,
    authenticatedAt: Date.now(), lastVerifiedAt: Date.now() } } as typeof req.session;
  next();
});
registerSalaryRoutes(app);
registerAttendanceRoutes(app);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve, reject) => {
  server.once('listening', resolve);
  server.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
type CapturedQuery = { text: string; parameters: any[] };
let queries: CapturedQuery[] = [];
let stage = 'seed.employees';
sql.options.debug = (_id: number, text: string, parameters: any[]) => {
  queries.push({ text, parameters: [...parameters] });
};
const percentile = (values: number[], quantile: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1];
const round = (value: number) => Math.round(value * 1000) / 1000;
function verifySalaries(rows: any[]) {
  for (const row of rows) {
    assert.equal(row.grossSalary, 30300);
    assert.equal(row.totalDeductions, 1000);
    assert.equal(row.netSalary, 29300);
    assert.equal(row.grossSalary - row.totalDeductions, row.netSalary);
    assert.equal(row.attendanceData.length, 22);
  }
}
async function http(endpoint: string) {
  const response = await fetch(`${origin}${endpoint}`);
  assert.equal(response.status, 200);
  const text = await response.text();
  return { body: JSON.parse(text), bytes: Buffer.byteLength(text) };
}
async function measure(name: string, action: () => Promise<any>, verify: (result: any) => void) {
  stage = name;
  for (let i = 0; i < 5; i++) verify(await action());
  const plansToCapture = new Map<string, CapturedQuery>();
  const times: number[] = [], counts: number[] = [], bytes: number[] = [];
  global.gc?.();
  const before = process.memoryUsage();
  let peakRss = before.rss, peakHeapUsed = before.heapUsed;
  for (let i = 0; i < 30; i++) {
    queries = [];
    const start = performance.now();
    const value = await action();
    times.push(performance.now() - start);
    counts.push(queries.length);
    for (const query of queries) plansToCapture.set(query.text, query);
    // Correctness assertions are deliberately outside the measured time.
    verify(value);
    if (value.bytes !== undefined) bytes.push(value.bytes);
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
  }
  const after = process.memoryUsage();
  const plans = [];
  for (const query of plansToCapture.values()) {
    assert.match(query.text.trim(), /^select\b/i);
    const plan = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`, query.parameters);
    plans.push({ sql: query.text, parameters: query.parameters, plan: plan[0]['QUERY PLAN'] });
  }
  return { name, p50Ms: round(percentile(times, 0.5)), p95Ms: round(percentile(times, 0.95)),
    minMs: round(Math.min(...times)), maxMs: round(Math.max(...times)),
    queryCount: { min: Math.min(...counts), max: Math.max(...counts) },
    responseBytes: bytes.length ? { min: Math.min(...bytes), max: Math.max(...bytes) } : null,
    memory: { before, after, peakRssObservedBytes: peakRss, peakHeapUsedObservedBytes: peakHeapUsed },
    samplesMs: times.map(round), plans, correctness: 'passed' };
}

try {
  await sql`insert into employees (id, name, id_number) select g,
    'Synthetic_' || lpad(g::text, 3, '0'), 'SYNTHETIC_NOT_AN_ID_' || g from generate_series(1,100) g`;
  let previousSize = 0;
  for (const size of [100, 1000, 10000]) {
    stage = `seed.salary.${size}`;
    const seedStarted = performance.now();
    // 100 synthetic employees, each with a unique year/month. Stable integer money.
    await sql`insert into salary_records (salary_year, salary_month, employee_id, employee_name,
      base_salary, holiday_calculation_base_salary, housing_allowance, welfare_allowance,
      gross_salary, total_deductions, net_salary, deductions, allowances, attendance_data)
      select 2018 + ((g-1)/1200), 1 + (((g-1)/100)%12), 1+((g-1)%100),
        'Synthetic_' || lpad((1+((g-1)%100))::text,3,'0'), 30000,30000,100,200,30300,1000,29300,
        '[{"name":"Synthetic deduction","amount":1000}]'::json,
        '[{"name":"Synthetic allowance","amount":200}]'::json,
        (select json_agg(json_build_object('id',d,'employeeId',1+((g-1)%100),
          'date', (2018 + ((g-1)/1200))::text || '-' || lpad((1+(((g-1)/100)%12))::text,2,'0') || '-' || lpad(d::text,2,'0'),
          'clockIn','08:00','clockOut','17:00','isHoliday',false,'isBarcodeScanned',false,
          'holidayId',null,'holidayType',null,'createdAt',null,'overtimeHours',json_build_object('ot1',0,'ot2',0)))
          from generate_series(1,22) d)
      from generate_series(${previousSize + 1}::int,${size}::int) g`;
    await sql`insert into temporary_attendance (employee_id,date,clock_in,clock_out)
      select 1+((g-1)%100), (date '2018-01-01' + ((g-1)/100))::text,'08:00','17:00'
      from generate_series(${previousSize + 1}::int,${size}::int) g`;
    stage = `verify.aggregate.${size}`;
    for (const table of ['salary_records', 'temporary_attendance', 'employees']) await sql.unsafe(`ANALYZE ${table}`);
    const [aggregate] = await sql`select count(*)::int as count, sum(gross_salary) as gross,
      sum(total_deductions) as deductions, sum(net_salary) as net from salary_records`;
    assert.deepEqual(aggregate, { count: size, gross: 30300 * size, deductions: 1000 * size, net: 29300 * size });
    const dataset: any = { salaryRows: size, attendanceRows: size, employees: 100,
      seedExcludedMs: round(performance.now() - seedStarted), aggregate, operations: [] };
    const page = Math.ceil(size / 50);
    const salaryCheck = (value: any, total = size) => { assert.equal(value.total, total); assert.equal(value.rows.length, Math.min(50, total)); verifySalaries(value.rows); };
    dataset.operations.push(await measure('repository.salary.first50',
      () => salaryRepository.getAllSalaryRecordsPage(1, 50), salaryCheck));
    dataset.operations.push(await measure('repository.salary.last50',
      () => salaryRepository.getAllSalaryRecordsPage(page, 50), salaryCheck));
    dataset.operations.push(await measure('repository.salary.search',
      () => salaryRepository.getAllSalaryRecordsPage(1, 50, { search: 'Synthetic_050' }),
      value => salaryCheck(value, size / 100)));
    dataset.operations.push(await measure('repository.attendance.first50',
      () => storage.getTemporaryAttendancePage(1, 50), value => { assert.equal(value.total, size); assert.equal(value.rows.length, 50); }));
    for (const [name, endpoint, total] of [
      ['http.salary.first50', '/api/salary-records?limit=50', size],
      ['http.salary.last50', `/api/salary-records?limit=50&page=${page}`, size],
      ['http.salary.search', '/api/salary-records?limit=50&search=Synthetic_050', size / 100],
    ] as const) {
      dataset.operations.push(await measure(name, () => http(endpoint), value => {
        assert.equal(value.body.pagination.total, total);
        assert.equal(value.body.data.length, Math.min(50, total)); verifySalaries(value.body.data);
      }));
    }
    dataset.operations.push(await measure('http.salary.finalized-months',
      () => http('/api/salary-records/finalized-months'), value => assert.equal(value.body.data.length, size)));
    dataset.operations.push(await measure('http.attendance.first50',
      () => http('/api/attendance?limit=50'), value => {
        assert.equal(value.body.pagination.total, size); assert.equal(value.body.data.length, 50);
      }));
    report.datasets.push(dataset);
    console.log(JSON.stringify({ salaryRows: size, correctness: 'passed', results: dataset.operations.map((operation: any) => ({
      name: operation.name, p50Ms: operation.p50Ms, p95Ms: operation.p95Ms, queryCount: operation.queryCount,
    })) }));
    previousSize = size;
  }
  report.status = 'passed';
  report.processResourceUsage = process.resourceUsage();
  const filename = `tmp/performance/benchmark-${Date.now()}.json`;
  await writeFile(filename, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, report: filename }));
} catch (error: any) {
  // Avoid printing driver exceptions or potentially sensitive environmental values.
  console.error(JSON.stringify({ status: 'failed', stage,
    code: /^[a-z0-9_]{1,40}$/i.test(error?.code ?? '') ? error.code : 'UNKNOWN',
    source: error?.stack?.split('\n').find((line: string) => line.includes('benchmark-payroll-worker.ts'))?.trim(),
  }));
  process.exitCode = 1;
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await sql.end({ timeout: 5 });
}
}

try {
  await runBenchmark();
} catch {
  // Includes setup/import/connection errors; never print URLs or driver messages.
  console.error('Synthetic benchmark setup failed; verify explicit fresh loopback database configuration.');
  process.exitCode = 1;
} finally {
  await closeDatabase?.().catch(() => {});
}
