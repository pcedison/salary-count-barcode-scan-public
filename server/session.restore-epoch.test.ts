import type { Store } from 'express-session';
import { describe, expect, it, vi } from 'vitest';
import { createJsonTestServer, jsonRequest } from './test-utils/http-test-server';
import { clearAdminSession, createAdminSession, promoteAdminSession, setupAdminSession } from './session';
import { requireAdmin } from './middleware/requireAdmin';
import { PermissionLevel } from './admin-auth';
import { handleRouteError } from './routes/route-helpers';

vi.mock('./storage', () => ({ storage: {} }));

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('administrator restore epoch', () => {
  it('refuses an old SID even when a slow authenticated GET saves it after restore', async () => {
    let epoch = '0';
    let sid = '';
    let store: Store | undefined;
    const entered = gate(), finish = gate();
    const server = await createJsonTestServer(app => {
      app.post('/api/verify-admin', async (req, res) => {
        await createAdminSession(req);
        sid = req.sessionID;
        store = req.sessionStore;
        res.json({ success: true });
      });
      app.get('/slow', requireAdmin(), async (req, res) => {
        req.session.adminAuth!.lastVerifiedAt += 1;
        entered.resolve();
        await finish.promise;
        res.json({ success: true });
      });
      app.get('/protected', requireAdmin(), (_req, res) => res.json({ success: true }));
      app.post('/restore', requireAdmin(), async (req, res) => {
        epoch = '11111111-1111-4111-8111-111111111111';
        await new Promise<void>((resolve, reject) => req.sessionStore.clear!(error => error ? reject(error) : resolve()));
        await clearAdminSession(req, res);
        res.json({ success: true });
      });
    }, { setupApp: app => setupAdminSession(app, { readRestoreEpoch: async () => epoch }) });
    let slow: Promise<Response> | undefined;
    try {
      const login = await jsonRequest(server.baseUrl, '/api/verify-admin', { method: 'POST' });
      const cookie = login.response.headers.get('set-cookie')!.split(';')[0];
      slow = fetch(`${server.baseUrl}/slow`, { headers: { Cookie: cookie } });
      await entered.promise;
      expect((await jsonRequest(server.baseUrl, '/restore', { method: 'POST', headers: { Cookie: cookie } })).response.status).toBe(200);
      finish.resolve();
      expect((await slow).status).toBe(200);
      const resurrected = await new Promise<any>((resolve, reject) => store!.get(sid, (error, value) => error ? reject(error) : resolve(value)));
      expect(resurrected.adminAuth.restoreEpoch).toBe('0');
      const staleLogin = await jsonRequest<{ code: string }>(server.baseUrl, '/api/verify-admin', { method: 'POST', headers: { Cookie: cookie } });
      expect(staleLogin.response.status).toBe(401);
      expect(staleLogin.body?.code).toBe('AUTH_RESTORE_CHANGED');
      expect(staleLogin.response.headers.get('set-cookie')).toContain('Expires=Thu, 01 Jan 1970');
      expect((await jsonRequest(server.baseUrl, '/protected', { headers: { Cookie: cookie } })).response.status).toBe(401);
      const fresh = await jsonRequest(server.baseUrl, '/api/verify-admin', { method: 'POST' });
      const freshCookie = fresh.response.headers.get('set-cookie')!.split(';')[0];
      expect(freshCookie).not.toBe(cookie);
      expect((await jsonRequest(server.baseUrl, '/protected', { headers: { Cookie: freshCookie } })).response.status).toBe(200);
    } finally { finish.resolve(); await slow?.catch(() => undefined); await server.close(); }
  });

  it.each(['/api/verify-admin', '/api/verify-admin/', '/API/VERIFY-ADMIN'])('rejects credentials verified before a restore at %s', async loginPath => {
    let epoch = '0';
    const entered = gate(), finish = gate();
    const server = await createJsonTestServer(app => {
      app.post('/api/verify-admin', async (req, res) => {
        entered.resolve();
        await finish.promise; // Represents slow verification of the old PIN.
        try { await createAdminSession(req); res.json({ success: true }); }
        catch (error) { handleRouteError(error, res); }
      });
    }, { setupApp: app => setupAdminSession(app, { readRestoreEpoch: async () => epoch }) });
    let login: Promise<Response> | undefined;
    try {
      login = fetch(`${server.baseUrl}${loginPath}`, { method: 'POST' });
      await entered.promise;
      epoch = '22222222-2222-4222-8222-222222222222';
      finish.resolve();
      const result = await login;
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({ code: 'AUTH_RESTORE_CHANGED' });
      expect(result.headers.get('set-cookie')).toBeNull();
    } finally { finish.resolve(); await login?.catch(() => undefined); await server.close(); }
  });

  it('rejects an elevation that crosses a restore', async () => {
    let epoch = '0';
    const entered = gate(), finish = gate();
    const server = await createJsonTestServer(app => {
      app.post('/api/verify-admin', async (req, res) => { await createAdminSession(req); res.json({ success: true }); });
      app.post('/api/admin/elevate-super', requireAdmin(), async (req, res) => {
        entered.resolve();
        await finish.promise;
        try { await promoteAdminSession(req, PermissionLevel.SUPER); res.json({ success: true }); }
        catch (error) { handleRouteError(error, res); }
      });
    }, { setupApp: app => setupAdminSession(app, { readRestoreEpoch: async () => epoch }) });
    let elevation: Promise<Response> | undefined;
    try {
      const login = await jsonRequest(server.baseUrl, '/api/verify-admin', { method: 'POST' });
      elevation = fetch(`${server.baseUrl}/api/admin/elevate-super`, { method: 'POST', headers: { Cookie: login.response.headers.get('set-cookie')!.split(';')[0] } });
      await entered.promise;
      epoch = '33333333-3333-4333-8333-333333333333';
      finish.resolve();
      expect((await elevation).status).toBe(409);
    } finally { finish.resolve(); await elevation?.catch(() => undefined); await server.close(); }
  });
});
