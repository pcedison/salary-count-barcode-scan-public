import type { Express } from 'express';

import { strictLimiter, lineBindLimiter, lineSessionLimiter } from '../../middleware/rateLimiter';
import { requireAdmin } from '../../middleware/requireAdmin';
import { storage } from '../../storage';
import { handleRouteError, parseNumericId } from '../route-helpers';
import { pushMessage } from '../../services/line.service';
import {
  log, setNoStore, maskLineUserId,
  requireLineSession, ensureConfigured, assertAuthorizedLineUser
} from './shared';

export function registerLineBindRoutes(app: Express): void {
  app.post('/api/line/bind', lineBindLimiter, async (req, res) => {
    if (!ensureConfigured(res)) return;
    const lineSession = requireLineSession(req, res);
    if (!lineSession) return;
    if (!assertAuthorizedLineUser(req, res, lineSession, req.body?.lineUserId)) return;

    const idNumber = typeof req.body?.idNumber === 'string' ? req.body.idNumber.trim() : '';
    if (!idNumber) {
      return res.status(400).json({
        success: false,
        code: 'ID_NUMBER_REQUIRED',
        error: 'Employee identifier is required.'
      });
    }

    try {
      const alreadyBound = await storage.getEmployeeByLineUserId(lineSession.lineUserId);
      if (alreadyBound) {
        return res.status(409).json({
          success: false,
          code: 'LINE_ALREADY_BOUND',
          error: 'This LINE account is already bound to an employee.',
          alreadyBound: true
        });
      }

      const employee = await storage.getEmployeeByIdNumber(idNumber);
      if (!employee) {
        return res.status(404).json({ success: false, code: 'EMPLOYEE_NOT_FOUND', error: 'Employee not found.' });
      }
      if (!employee.active) {
        return res.status(403).json({
          success: false,
          code: 'EMPLOYEE_INACTIVE',
          error: 'Inactive employees cannot bind LINE login.'
        });
      }

      const existing = await storage.getPendingBindingByLineUserId(lineSession.lineUserId);
      if (existing && existing.status === 'pending') {
        return res.json({ success: true, status: 'pending', message: 'Binding request is already pending review.' });
      }

      await storage.createPendingBinding({
        employeeId: employee.id,
        lineUserId: lineSession.lineUserId,
        lineDisplayName: lineSession.lineDisplayName,
        linePictureUrl: lineSession.linePictureUrl ?? null,
        status: 'pending',
        requestedAt: new Date()
      });

      log.info(`Created LINE binding request for employee ${employee.id} using ${maskLineUserId(lineSession.lineUserId)}`);
      return res.json({ success: true, status: 'pending', employeeName: employee.name });
    } catch (err) {
      log.error('Failed to create LINE binding request', err);
      return handleRouteError(err, res);
    }
  });

  app.get('/api/line/binding-status/:lineUserId', lineSessionLimiter, async (req, res) => {
    setNoStore(res);
    const lineSession = requireLineSession(req, res);
    if (!lineSession) return;
    if (!assertAuthorizedLineUser(req, res, lineSession, req.params.lineUserId)) return;

    try {
      const employee = await storage.getEmployeeByLineUserId(lineSession.lineUserId);
      if (employee) {
        return res.json({ status: 'bound', employeeId: employee.id, employeeName: employee.name, department: employee.department });
      }
      const pending = await storage.getPendingBindingByLineUserId(lineSession.lineUserId);
      if (pending?.status === 'pending') return res.json({ status: 'pending' });
      return res.json({ status: 'unbound' });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.get('/api/line/pending-bindings', requireAdmin(), async (_req, res) => {
    try {
      setNoStore(res);
      // getPendingBindings() now joins employees in a single query — no N+1
      const bindings = await storage.getPendingBindings();
      return res.json(bindings);
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.post('/api/line/pending-bindings/:id/approve', strictLimiter, requireAdmin(), async (req, res) => {
    const id = parseNumericId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid binding id' });

    try {
      const binding = await storage.approvePendingBinding(id, 'admin');
      if (!binding) return res.status(404).json({ error: 'Pending binding not found' });

      await pushMessage(
        binding.lineUserId,
        'Your LINE account has been approved. You can now use LINE to clock in and clock out.'
      );

      log.info(`Approved LINE binding ${id} for ${maskLineUserId(binding.lineUserId)}`);
      return res.json({ success: true, binding });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.post('/api/line/pending-bindings/:id/reject', strictLimiter, requireAdmin(), async (req, res) => {
    const id = parseNumericId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid binding id' });

    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim()
        : 'Binding request was rejected by an administrator.';

    try {
      const binding = await storage.rejectPendingBinding(id, 'admin', reason);
      if (!binding) return res.status(404).json({ error: 'Pending binding not found' });

      await pushMessage(binding.lineUserId, `Your LINE binding request was rejected.\n\nReason: ${reason}`);

      log.info(`Rejected LINE binding ${id} for ${maskLineUserId(binding.lineUserId)}`);
      return res.json({ success: true, binding });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.delete('/api/line/pending-bindings/:id', strictLimiter, requireAdmin(), async (req, res) => {
    const id = parseNumericId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid binding id' });

    try {
      const deleted = await storage.deletePendingBinding(id);
      if (!deleted) return res.status(404).json({ error: 'Pending binding not found' });
      return res.json({ success: true });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });
}
