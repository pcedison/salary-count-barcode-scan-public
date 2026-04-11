import type { Express } from 'express';

import { insertHolidaySchema, type Holiday } from '@shared/schema';
import { removeSpecialLeaveDate } from '@shared/utils/specialLeaveSync';

import { requireAdmin } from '../middleware/requireAdmin';
import { storage } from '../storage';
import { createLogger } from '../utils/logger';

import { handleRouteError, parseNumericId } from './route-helpers';

const log = createLogger('holidays');

const HOLIDAY_TYPE_LABELS: Record<string, string> = {
  national_holiday: '國定假日',
  special_leave: '特別休假',
  typhoon_leave: '颱風假',
  sick_leave: '病假',
  personal_leave: '事假',
  worked: '假日出勤'
};

async function ensureHolidayAttendanceRecord(holiday: Holiday) {
  if (!holiday.employeeId) {
    return;
  }

  const existingRecords = await storage.getTemporaryAttendanceByEmployeeAndDate(
    holiday.employeeId,
    holiday.date
  );

  if (existingRecords.length > 0) {
    return;
  }

  const isNoClockType =
    holiday.holidayType === 'national_holiday' ||
    holiday.holidayType === 'typhoon_leave' ||
    holiday.holidayType === 'special_leave';

  await storage.createTemporaryAttendance({
    employeeId: holiday.employeeId,
    date: holiday.date,
    clockIn: isNoClockType ? '--:--' : '08:00',
    clockOut: isNoClockType ? '--:--' : '17:00',
    isHoliday: true,
    isBarcodeScanned: false,
    holidayId: holiday.id,
    holidayType: holiday.holidayType
  });

  const employee = await storage.getEmployeeById(holiday.employeeId);
  log.info(
    `為員工 ${employee?.name || holiday.employeeId} 創建${HOLIDAY_TYPE_LABELS[holiday.holidayType] || '假日'}考勤記錄: ${holiday.date}`
  );
}

async function syncDeletedSpecialLeaveHoliday(holiday: Holiday) {
  if (holiday.holidayType !== 'special_leave' || !holiday.employeeId) {
    return;
  }

  try {
    const employee = await storage.getEmployeeById(holiday.employeeId);
    if (!employee) {
      return;
    }

    const currentDates = employee.specialLeaveUsedDates || [];
    const updatedDates = removeSpecialLeaveDate(currentDates, holiday.date);

    if (updatedDates.length === currentDates.length) {
      return;
    }

    await storage.updateEmployee(holiday.employeeId, {
      specialLeaveUsedDates: updatedDates
    });

    log.info(`從員工 ${employee.name} 的特休日期中移除 ${holiday.date}`);
  } catch (syncErr) {
    log.error('反向同步失敗:', syncErr);
  }
}

export function registerHolidayRoutes(app: Express): void {
  app.get('/api/holidays', requireAdmin(), async (_req, res) => {
    try {
      const holidays = await storage.getAllHolidays();
      return res.json(holidays);
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.post('/api/holidays', requireAdmin(), async (req, res) => {
    try {
      const validatedData = insertHolidaySchema.parse(req.body);
      const holiday = await storage.createHoliday(validatedData);

      await ensureHolidayAttendanceRecord(holiday);

      return res.status(201).json(holiday);
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.delete('/api/holidays/:id', requireAdmin(), async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) {
        return res.status(400).json({ message: 'Invalid ID' });
      }

      const holiday = await storage.getHolidayById(id);
      if (!holiday) {
        return res.status(404).json({ message: 'Holiday not found' });
      }

      await storage.deleteTemporaryAttendanceByHolidayId(id);
      log.info(`已刪除假日 ID:${id} 對應的考勤記錄`);

      await syncDeletedSpecialLeaveHoliday(holiday);

      const success = await storage.deleteHoliday(id);
      if (!success) {
        return res.status(404).json({ message: 'Holiday not found' });
      }

      return res.status(204).end();
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.delete('/api/holidays', requireAdmin(), async (_req, res) => {
    try {
      await storage.deleteAllHolidays();
      return res.status(204).end();
    } catch (err) {
      return handleRouteError(err, res);
    }
  });
}
