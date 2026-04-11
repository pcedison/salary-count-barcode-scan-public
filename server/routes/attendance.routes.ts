import type { Express } from 'express';

import { insertTemporaryAttendanceSchema } from '@shared/schema';

import { PermissionLevel } from '../admin-auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { hasActiveScanAccessSession, hasAdminSession } from '../session';
import { recordLatency } from '../observability/runtimeMetrics';
import { storage } from '../storage';
import { createLogger } from '../utils/logger';

import { getTodayDateKey } from './attendance-helpers';
import { handleRouteError, parseNumericId } from './route-helpers';

const log = createLogger('attendance');

function parseBoundedPagination(queryPage: unknown, queryLimit: unknown) {
  const page = Math.max(1, parseInt(String(queryPage ?? '1'), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(queryLimit ?? '50'), 10) || 50));

  return { page, limit };
}

function toPublicTodayAttendanceRecord(
  record: Awaited<ReturnType<typeof storage.getTemporaryAttendanceByDate>>[number],
  employeeDirectory: Map<number, { name: string; department: string | null }>
) {
  const employeeId = record.employeeId ?? null;
  const employee = employeeId === null ? undefined : employeeDirectory.get(employeeId);

  return {
    id: record.id,
    employeeName: employee?.name ?? 'Unknown employee',
    department: employee?.department ?? null,
    date: record.date,
    clockIn: record.clockIn,
    clockOut: record.clockOut,
    isBarcodeScanned: Boolean(record.isBarcodeScanned)
  };
}

export function registerAttendanceRoutes(app: Express): void {
  app.get('/api/attendance', requireAdmin(), async (req, res) => {
    const startedAt = Date.now();

    try {
      const { page, limit } = parseBoundedPagination(req.query.page, req.query.limit);
      const { rows, total } = await storage.getTemporaryAttendancePage(page, limit);
      return res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (err) {
      log.error('Failed to load attendance records', err);
      return handleRouteError(err, res);
    } finally {
      recordLatency('api.attendance.list', Date.now() - startedAt);
    }
  });

  app.get('/api/attendance/today', async (_req, res) => {
    try {
      const hasKioskAccess =
        hasActiveScanAccessSession(_req) ||
        hasAdminSession(_req, PermissionLevel.ADMIN);

      if (!hasKioskAccess) {
        res.setHeader('X-Scan-Session-Required', 'true');
        return res.status(401).json({
          success: false,
          code: 'SCAN_SESSION_REQUIRED',
          message: 'Kiosk attendance is available only after the barcode kiosk is unlocked.'
        });
      }

      const startTime = Date.now();
      const todayDateKey = getTodayDateKey();
      const todayRecords = (await storage.getTemporaryAttendanceByDate(todayDateKey))
        .filter((record) => record.isBarcodeScanned === true);
      const employees = await storage.getAllEmployees();
      const employeeDirectory = new Map(
        employees.map((employee) => [
          employee.id,
          {
            name: employee.name,
            department: employee.department ?? null
          }
        ])
      );

      log.debug(
        `Loaded public today attendance payload in ${Date.now() - startTime}ms (${todayRecords.length} records)`
      );

      return res.json(
        todayRecords.map((record) => toPublicTodayAttendanceRecord(record, employeeDirectory))
      );
    } catch (err) {
      log.error('Failed to load today attendance records', err);
      return handleRouteError(err, res);
    }
  });

  app.post('/api/attendance', requireAdmin(), async (req, res) => {
    try {
      const validatedData = insertTemporaryAttendanceSchema.parse(req.body);
      const attendance = await storage.createTemporaryAttendance(validatedData);
      return res.status(201).json(attendance);
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.put('/api/attendance/:id', requireAdmin(), async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) {
        return res.status(400).json({ message: 'Invalid ID' });
      }

      const validatedData = insertTemporaryAttendanceSchema.partial().parse(req.body);
      const updatedAttendance = await storage.updateTemporaryAttendance(id, validatedData);

      if (!updatedAttendance) {
        return res.status(404).json({ message: 'Attendance record not found' });
      }

      return res.json(updatedAttendance);
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.delete('/api/attendance/:id', requireAdmin(), async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) {
        return res.status(400).json({ message: 'Invalid ID' });
      }

      const success = await storage.deleteTemporaryAttendance(id);
      if (!success) {
        return res.status(404).json({ message: 'Attendance record not found' });
      }

      return res.status(204).end();
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.delete('/api/attendance', requireAdmin(), async (_req, res) => {
    try {
      await storage.deleteAllTemporaryAttendance();
      return res.status(204).end();
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.delete('/api/attendance/employee/:employeeId', requireAdmin(), async (req, res) => {
    try {
      const employeeId = parseNumericId(req.params.employeeId);
      if (employeeId === null) {
        return res.status(400).json({ message: 'Invalid employee ID' });
      }

      await storage.deleteTemporaryAttendanceByEmployeeId(employeeId);
      return res.status(204).end();
    } catch (err) {
      return handleRouteError(err, res);
    }
  });
}
