import type { Express } from 'express';

import { normalizeDateToSlash } from '@shared/utils/specialLeaveSync';

import { lineClockInLimiter } from '../../middleware/rateLimiter';
import { storage } from '../../storage';
import { handleRouteError } from '../route-helpers';
import { getTaiwanDateTimeParts } from '../scan-helpers';
import { sendClockInNotification } from '../../services/line.service';
import { log, requireLineSession, ensureConfigured, assertAuthorizedLineUser } from './shared';

export function registerLineClockInRoutes(app: Express): void {
  app.post('/api/line/clock-in', lineClockInLimiter, async (req, res) => {
    if (!ensureConfigured(res)) return;
    const lineSession = requireLineSession(req, res);
    if (!lineSession) return;
    if (!assertAuthorizedLineUser(req, res, lineSession, req.body?.lineUserId)) return;

    try {
      const employee = await storage.getEmployeeByLineUserId(lineSession.lineUserId);
      if (!employee) {
        return res.status(404).json({
          success: false,
          code: 'LINE_EMPLOYEE_NOT_BOUND',
          error: 'This LINE account is not bound to an employee.'
        });
      }
      if (!employee.active) {
        return res.status(403).json({
          success: false,
          code: 'EMPLOYEE_INACTIVE',
          error: 'Inactive employees cannot clock in with LINE.'
        });
      }

      const { dateKey, time, timestamp } = getTaiwanDateTimeParts();
      const todayRecords = await storage.getTemporaryAttendanceByEmployeeAndDate(employee.id, dateKey);
      const normalizedDateKey = normalizeDateToSlash(dateKey);
      const todayFiltered = todayRecords.filter(
        (record) => normalizeDateToSlash(record.date) === normalizedDateKey
      );
      const incomplete = todayFiltered
        .filter((record) => record.clockIn && !record.clockOut)
        .sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];

      let attendance;
      let isClockIn: boolean;

      if (incomplete) {
        attendance = await storage.updateTemporaryAttendance(incomplete.id, { clockOut: time });
        isClockIn = false;
      } else {
        attendance = await storage.createTemporaryAttendance({
          employeeId: employee.id,
          date: dateKey,
          clockIn: time,
          clockOut: '',
          isHoliday: false,
          isBarcodeScanned: true
        });
        isClockIn = true;
      }

      sendClockInNotification(lineSession.lineUserId, employee.name, time, isClockIn).catch((err) =>
        log.warn('Failed to send LINE clock-in notification', err)
      );

      return res.json({
        success: true,
        action: isClockIn ? 'clock-in' : 'clock-out',
        employeeName: employee.name,
        department: employee.department,
        clockTime: time,
        timestamp,
        attendance
      });
    } catch (err) {
      log.error('LINE clock-in request failed', err);
      return handleRouteError(err, res);
    }
  });
}
