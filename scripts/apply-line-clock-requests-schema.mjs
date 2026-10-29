import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { assertExternalDatabaseTlsUrl } from '../shared/databaseTls.mjs';

const MARKER = 'barcode-scan:line-clock-requests:v1';
const EXPECTED = [
  ['event_id', 'uuid'], ['employee_id', 'integer'], ['line_user_hash', 'text'],
  ['payload_hash', 'text'], ['date_key', 'text'], ['state_version', 'text'],
  ['receipt', 'json'], ['created_at', 'timestamp with time zone'],
];

export async function checkLineClockSchema(client) {
  const relation = await client.query(`SELECT c.relrowsecurity AS rls, obj_description(c.oid, 'pg_class') AS marker
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='line_clock_requests' AND c.relkind='r'`);
  if (!relation.rowCount) return { ready: false, reason: 'missing-table' };
  const columns = await client.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='line_clock_requests' ORDER BY ordinal_position`);
  const shape = columns.rows.map(row => [row.column_name, row.data_type]);
  const constraints = await client.query(`SELECT contype, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='public.line_clock_requests'::regclass`);
  const hasPrimary = constraints.rows.some(row => row.contype === 'p' && row.definition === 'PRIMARY KEY (event_id)');
  const hasForeign = constraints.rows.some(row => row.contype === 'f' && /FOREIGN KEY \(employee_id\) REFERENCES (?:public\.)?employees\(id\) ON DELETE CASCADE/.test(row.definition));
  const index = await client.query(`SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE i.indrelid='public.line_clock_requests'::regclass AND c.relname='line_clock_requests_employee_date_idx' AND i.indisvalid`);
  const exposed = await client.query(`SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r',c.relowner))) a
    LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE c.oid='public.line_clock_requests'::regclass
    AND (a.grantee=0 OR r.rolname IN ('anon','authenticated')) LIMIT 1`);
  const ready = relation.rows[0].marker === MARKER && relation.rows[0].rls &&
    JSON.stringify(shape) === JSON.stringify(EXPECTED) && columns.rows.every(row => row.is_nullable === 'NO') &&
    hasPrimary && hasForeign && index.rowCount === 1 && exposed.rowCount === 0;
  return { ready, reason: ready ? 'verified' : 'incompatible-or-exposed-table' };
}

export async function applyLineClockSchema(client) {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('barcode-scan:line-clock-requests:migration',0))`);
    const before = await checkLineClockSchema(client);
    if (!before.ready && before.reason !== 'missing-table') throw new Error('Existing receipt table is incompatible; no changes applied.');
    if (!before.ready) await client.query(await readFile(new URL('../line_clock_requests_schema.sql', import.meta.url), 'utf8'));
    const after = await checkLineClockSchema(client);
    if (!after.ready) throw new Error('Receipt schema verification failed.');
    await client.query('COMMIT');
    return { ...after, applied: !before.ready };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check', '--apply'].includes(args[0])) throw new Error('Use exactly --check or --apply.');
  // Never auto-load .env; the operator explicitly supplies the target connection.
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL must be supplied explicitly.');
  assertExternalDatabaseTlsUrl(connectionString);
  const hostname = new URL(connectionString).hostname.replace(/^\[|\]$/g, '');
  const local = ['127.0.0.1', 'localhost', '::1'].includes(hostname);
  const client = new pg.Client({ connectionString, ssl: local ? false : { rejectUnauthorized: true } });
  await client.connect();
  try {
    const result = args[0] === '--apply' ? await applyLineClockSchema(client) : await checkLineClockSchema(client);
    console.log(JSON.stringify({ mode: args[0].slice(2), ...result }));
    if (!result.ready) process.exitCode = 1;
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('LINE receipt schema check/apply failed; verify target, privileges and schema compatibility.'); process.exitCode = 1; });
}
