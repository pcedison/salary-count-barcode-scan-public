import type { Express, Request, Response } from 'express';
import { lineClockInLimiter, lineSessionLimiter } from '../../middleware/rateLimiter';
import { storage } from '../../storage';
import { handleRouteError } from '../route-helpers';
import { lineClockInRepository } from '../../repositories/lineClockInRepository';
import { sendClockInNotification } from '../../services/line.service';
import { log, requireLineSession, ensureConfigured, assertAuthorizedLineUser, setNoStore } from './shared';

async function authorizedEmployee(req: Request, res: Response) {
  setNoStore(res);
  if (!ensureConfigured(res)) return;
  const lineSession = requireLineSession(req, res);
  if (!lineSession) return;
  if (!assertAuthorizedLineUser(req, res, lineSession, req.body?.lineUserId ?? req.query.lineUserId)) return;
  const employee = await storage.getEmployeeByLineUserId(lineSession.lineUserId);
  if (!employee) {
    res.status(404).json({ success: false, code: 'LINE_EMPLOYEE_NOT_BOUND', error: 'This LINE account is not bound to an employee.' });
    return;
  }
  if (!employee.active) {
    res.status(403).json({ success: false, code: 'EMPLOYEE_INACTIVE', error: 'Inactive employees cannot clock in with LINE.' });
    return;
  }
  return { employee, lineSession };
}

export function registerLineClockInRoutes(app: Express): void {
  app.get('/api/line/clock-in/state', lineSessionLimiter, async (req, res) => {
    try {
      const authorized = await authorizedEmployee(req, res);
      if (!authorized) return;
      return res.json(await lineClockInRepository.getState(authorized.employee.id, authorized.lineSession.lineUserId));
    } catch (error) { return handleRouteError(error, res); }
  });

  app.get('/api/line/clock-in/requests/:eventId', lineSessionLimiter, async (req, res) => {
    try {
      const authorized = await authorizedEmployee(req, res);
      if (!authorized) return;
      const receipt = await lineClockInRepository.getReceipt(authorized.employee.id, authorized.lineSession.lineUserId, req.params.eventId);
      if (!receipt) return res.status(404).json({ success: false, code: 'LINE_CLOCK_RECEIPT_NOT_FOUND', error: '尚未查到這次打卡回執。' });
      return res.json(receipt);
    } catch (error) { return handleRouteError(error, res); }
  });

  app.post('/api/line/clock-in', lineClockInLimiter, async (req, res) => {
    try {
      const authorized = await authorizedEmployee(req, res);
      if (!authorized) return;
      const { employee, lineSession } = authorized;
      const { receipt, replayed } = await lineClockInRepository.submit(employee.id, lineSession.lineUserId, req.body);
      // Best effort notification is sent only for the original committed event.
      if (!replayed) {
        sendClockInNotification(lineSession.lineUserId, receipt.employeeName, receipt.clockTime, receipt.action === 'clock-in')
          .catch(err => log.warn('Failed to send LINE clock-in notification', { name: err instanceof Error ? err.name : 'UnknownError' }));
      }
      return res.json(receipt);
    } catch (error) { return handleRouteError(error, res); }
  });
}
