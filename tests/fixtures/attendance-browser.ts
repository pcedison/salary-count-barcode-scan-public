import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { registerLineClockInRoutes } from '../../server/routes/line/clockin.routes';
import { setupAdminSession } from '../../server/session';
import { sql } from '../../server/db';

// Test-only process: real built UI, route, repository and disposable PostgreSQL.
// The launch script replaces only LINE notification/config exports at bundle time.
const root = process.cwd(), output = process.env.ATTENDANCE_FIXTURE_OUTPUT!;
const metadata = JSON.parse(readFileSync(path.join(output, 'postgres.json'), 'utf8'));
const target = new URL(process.env.DATABASE_URL!);
if (target.hostname !== '127.0.0.1' || Number(target.port) !== metadata.port || target.pathname !== '/' + metadata.database || !metadata.database.startsWith('attendance_browser_')) throw new Error('Fixture target ownership mismatch');
await sql.unsafe(`CREATE TABLE IF NOT EXISTS employees (
 id serial PRIMARY KEY,name text NOT NULL,id_number text NOT NULL UNIQUE,is_encrypted boolean DEFAULT false,
 position text,department text,email text,phone text,active boolean DEFAULT true,employee_type text DEFAULT 'local',
 line_user_id text,line_display_name text,line_picture_url text,line_binding_date timestamptz,
 special_leave_days integer DEFAULT 0,special_leave_work_date_range text,special_leave_used_dates json DEFAULT '[]',
 special_leave_cash_days integer DEFAULT 0,special_leave_cash_month text,special_leave_notes text,
 deleted_at timestamptz,deleted_by text,purge_after_at timestamptz,created_at timestamp DEFAULT now());
 CREATE TABLE IF NOT EXISTS temporary_attendance (
 id serial PRIMARY KEY,employee_id integer,date text NOT NULL,clock_in text NOT NULL,clock_out text DEFAULT '',
 is_holiday boolean DEFAULT false,is_barcode_scanned boolean DEFAULT false,holiday_id integer,holiday_type text,
 created_at timestamp DEFAULT now());`);
const pg = (await import('pg')).default;
const migrationClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
await migrationClient.connect();
try {
  const { applyLineClockSchema } = await import('../../scripts/apply-line-clock-requests-schema.mjs');
  await applyLineClockSchema(migrationClient);
} finally { await migrationClient.end(); }
await sql.unsafe(`INSERT INTO employees(id,name,id_number,department,line_user_id,line_display_name)
 VALUES (1001,'虛構員工甲','SYNTHETIC-A','隔離測試','U_FIXTURE_ATTENDANCE_A','虛構員工甲'),
 (1002,'虛構員工乙','SYNTHETIC-B','隔離測試','U_FIXTURE_ATTENDANCE_B','虛構員工乙') ON CONFLICT(id) DO NOTHING`);
const controlFile = path.join(output, 'control.json');
if (!existsSync(controlFile)) writeFileSync(controlFile, JSON.stringify({ authenticated: true, actor: 'A', faultId: '', mode: 'none', delayMs: 1000 }, null, 2));
const control = () => JSON.parse(readFileSync(controlFile, 'utf8'));
const consumed = new Set<string>(), events: unknown[] = [];
let expiredFaultId = '';
const actor = (which: string) => which === 'B'
  ? { id: 1002, name: '虛構員工乙', lineUserId: 'U_FIXTURE_ATTENDANCE_B' }
  : { id: 1001, name: '虛構員工甲', lineUserId: 'U_FIXTURE_ATTENDANCE_A' };
async function snapshot() {
  const result = {
    capturedAt: new Date().toISOString(),
    employees: await sql`SELECT id,name,active FROM employees ORDER BY id`,
    attendance: await sql`SELECT id,employee_id,date,clock_in,clock_out FROM temporary_attendance ORDER BY id`,
    receipts: await sql`SELECT event_id,employee_id,date_key,receipt FROM line_clock_requests ORDER BY created_at,event_id`,
    notifications: (globalThis as any).__fixtureNotifications || [], events,
  };
  writeFileSync(path.join(output, 'browser-state.json'), JSON.stringify(result, null, 2));
  return result;
}
const app = express();
app.disable('x-powered-by');
app.use(express.json());
setupAdminSession(app);
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const current = control(), person = actor(current.actor);
  if (current.authenticated && (!expiredFaultId || current.faultId !== expiredFaultId)) {
    req.session.lineAuth = { lineUserId: person.lineUserId, lineDisplayName: person.name, authenticatedAt: Date.now() };
  } else delete req.session.lineAuth;
  if (req.method !== 'POST' || req.path !== '/api/line/clock-in') return next();
  const fault = current.faultId && !consumed.has(current.faultId) ? current.mode : 'none';
  if (fault !== 'none') consumed.add(current.faultId);
  events.push({ type: 'request', eventId: req.body?.eventId, actor: person.id, fault, faultId: current.faultId || null });
  if (fault === 'unauthorized_once') delete req.session.lineAuth;
  const send = res.json.bind(res);
  res.json = body => {
    events.push({ type: 'response', eventId: req.body?.eventId, status: res.statusCode, success: body.success, action: body.action, code: body.code });
    if (body.success && fault === 'expire_after_commit') expiredFaultId = current.faultId;
    if (body.success && fault === 'drop_after_commit') {
      events.push({ type: 'response-dropped', faultId: current.faultId, eventId: req.body?.eventId });
      void snapshot(); res.destroy(); return res;
    }
    if (body.success && fault === 'delay_after_commit') {
      const delayMs = Math.max(100, Math.min(Number(current.delayMs) || 10000, 14000));
      events.push({ type: 'response-delayed', faultId: current.faultId, eventId: req.body?.eventId, delayMs });
      void snapshot();
      setTimeout(() => {
        events.push({ type: 'delayed-response-released', faultId: current.faultId, eventId: req.body?.eventId, disconnected: res.destroyed });
        void snapshot();
        if (!res.destroyed) send(body);
      }, delayMs);
      return res;
    }
    void snapshot(); return send(body);
  };
  if (fault === 'delay_before_route') setTimeout(next, Math.min(Number(current.delayMs) || 1000, 5000));
  else next();
});
app.get('/__fixture/state', async (_req, res) => { res.json(await snapshot()); });
app.get('/api/settings', (_req, res) => res.json({ barcodeEnabled: true }));
app.get('/api/admin/session', (_req, res) => res.json({ isAdmin: false, permissionLevel: 0 }));
app.get('/api/line/config', (_req, res) => res.json({ configured: true }));
app.get('/api/line/temp-data', (req, res) => req.session.lineAuth ? res.json(req.session.lineAuth) : res.status(401).json({ error: 'Fixture session expired' }));
app.get('/api/line/binding-status/:user', (req, res) => {
  const person = actor(control().actor);
  if (!req.session.lineAuth || req.params.user !== person.lineUserId) return res.status(401).json({ status: 'login' });
  return res.json({ status: 'bound', employeeName: person.name });
});
app.get('/api/line/login', (_req, res) => res.redirect('/clock-in'));
registerLineClockInRoutes(app);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not provided by isolated fixture' }));
app.use(express.static(path.join(root, 'dist/public'), { etag: false, lastModified: false }));
app.get('*', (_req, res) => res.sendFile(path.join(root, 'dist/public/index.html')));
const requestedPort = Number(process.env.ATTENDANCE_FIXTURE_PORT || 0);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Invalid isolated fixture port');
const server = app.listen(requestedPort, '127.0.0.1', async () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener missing');
  const identity = { pid: process.pid, executable: process.execPath, script: process.argv[1], startedAt: new Date().toISOString(), host: '127.0.0.1', port: address.port, url: `http://127.0.0.1:${address.port}/clock-in`, database: metadata.database, container: metadata.id };
  await snapshot();
  writeFileSync(path.join(output, 'browser-identity.json'), JSON.stringify(identity, null, 2));
  console.log(JSON.stringify(identity));
});
async function close() { server.close(async () => { await sql.end(); process.exit(0); }); }
process.on('SIGINT', close); process.on('SIGTERM', close);
