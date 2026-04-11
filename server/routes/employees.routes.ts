import type { Express, Request } from 'express';

import { insertEmployeeSchema, type Employee } from '@shared/schema';
import { diffSpecialLeaveDates, normalizeDateToSlash } from '@shared/utils/specialLeaveSync';

import { PermissionLevel } from '../admin-auth';
import { requireAdmin } from '../middleware/requireAdmin';
import { storage } from '../storage';
import {
  getEmployeeDisplayId,
  getEmployeeScanId,
  maskEmployeeIdentityForLog
} from '../utils/employeeIdentity';
import { createLogger } from '../utils/logger';
import { handleRouteError, parseNumericId } from './route-helpers';
import {
  EMPLOYEE_RECYCLE_RETENTION_DAYS,
  SALARY_RETENTION_YEARS
} from '../config/retentionPolicy';

const log = createLogger('employees');

const employeePatchSchema = insertEmployeeSchema
  .pick({
    specialLeaveDays: true,
    specialLeaveWorkDateRange: true,
    specialLeaveUsedDates: true,
    specialLeaveCashDays: true,
    specialLeaveCashMonth: true,
    specialLeaveNotes: true,
    name: true,
    idNumber: true,
    employeeType: true,
    position: true,
    department: true,
    email: true,
    phone: true,
    active: true
  })
  .partial();

function applyCreateEmployeeEncryptionFlag(
  requestBody: Record<string, any>,
  validatedData: Record<string, any>
) {
  const useEncryption = requestBody.useEncryption === true;
  const maskedId = maskEmployeeIdentityForLog(validatedData.idNumber || '');

  if (validatedData.idNumber && useEncryption) {
    log.info(`建立員工時啟用 AES 加密: ${maskedId}`);
    validatedData.isEncrypted = true;
    return;
  }

  log.info(`建立員工時維持明文識別碼: ${maskedId}`);
  validatedData.isEncrypted = false;
}

function applyUpdateEmployeeEncryptionFlag(
  requestBody: Record<string, any>,
  validatedData: Record<string, any>
) {
  const useEncryption = requestBody.useEncryption === true;
  const maskedId = maskEmployeeIdentityForLog(validatedData.idNumber || '');

  if (validatedData.idNumber && useEncryption) {
    log.info(`更新員工時啟用 AES 加密: ${maskedId}`);
    validatedData.isEncrypted = true;
    return;
  }

  if ('useEncryption' in requestBody) {
    log.info(`更新員工時維持明文識別碼: ${maskedId}`);
    validatedData.isEncrypted = false;
  }
}

async function syncEmployeeSpecialLeaveDates(
  employeeId: number,
  employeeName: string,
  oldDates: string[] = [],
  newDates: string[] = []
) {
  const { addedDates, removedDates } = diffSpecialLeaveDates(oldDates, newDates);
  if (addedDates.length === 0 && removedDates.length === 0) {
    return;
  }

  const allHolidays = await storage.getAllHolidays();
  const uniqueAddedDates = Array.from(new Set(addedDates));
  const uniqueRemovedDates = Array.from(new Set(removedDates));

  for (const date of uniqueAddedDates) {
    const dateSlash = normalizeDateToSlash(date);

    try {
      const existingHoliday = allHolidays.find((holiday) =>
        holiday.employeeId === employeeId &&
        holiday.holidayType === 'special_leave' &&
        (holiday.date === dateSlash || holiday.date === date)
      );

      if (existingHoliday) {
        continue;
      }

      const holiday = await storage.createHoliday({
        employeeId,
        date: dateSlash,
        name: '特別休假',
        holidayType: 'special_leave'
      });

      const existingAttendance = await storage.getTemporaryAttendanceByEmployeeAndDate(
        employeeId,
        dateSlash
      );

      if (existingAttendance.length === 0) {
        await storage.createTemporaryAttendance({
          employeeId,
          date: dateSlash,
          clockIn: '--:--',
          clockOut: '--:--',
          isHoliday: true,
          isBarcodeScanned: false,
          holidayId: holiday.id,
          holidayType: 'special_leave'
        });
      }

      allHolidays.push(holiday);
      log.info(`已為 ${employeeName} 建立特休假別: ${dateSlash}`);
    } catch (err) {
      log.error(`建立 ${date} 的特休同步失敗`, err);
    }
  }

  for (const date of uniqueRemovedDates) {
    const dateSlash = normalizeDateToSlash(date);

    try {
      const holidaysToRemove = allHolidays.filter((holiday) =>
        holiday.employeeId === employeeId &&
        holiday.holidayType === 'special_leave' &&
        (holiday.date === dateSlash || holiday.date === date)
      );

      for (const holiday of holidaysToRemove) {
        await storage.deleteTemporaryAttendanceByHolidayId(holiday.id);
        await storage.deleteHoliday(holiday.id);
        log.info(`已為 ${employeeName} 移除特休假別: ${holiday.date}`);
      }
    } catch (err) {
      log.error(`移除 ${date} 的特休同步失敗`, err);
    }
  }
}

function toPublicEmployeeProfile(employee: Employee) {
  return {
    id: employee.id,
    name: employee.name,
    position: employee.position,
    department: employee.department,
    active: employee.active
  };
}

function toAdminEmployeeProfile(employee: Employee, includeScanId = true) {
  const base = {
    ...employee,
    idNumber: getEmployeeDisplayId(employee),
  };

  if (includeScanId) {
    return {
      ...base,
      scanIdNumber: getEmployeeScanId(employee)
    };
  }

  return base;
}

function toDeletedEmployeeProfile(employee: Employee, includeScanId = true) {
  return {
    ...toAdminEmployeeProfile(employee, includeScanId),
    deletedAt: employee.deletedAt,
    deletedBy: employee.deletedBy,
    purgeAfterAt: employee.purgeAfterAt,
    recycleRetentionDays: EMPLOYEE_RECYCLE_RETENTION_DAYS,
    salaryRetentionMode: 'anonymized',
    salaryRetentionYears: SALARY_RETENTION_YEARS,
    lineRestoreMode: 'rebind_required'
  };
}

function resolveDeletedBy(req: Request) {
  return req.session?.adminAuth?.isAdmin ? 'admin' : 'system';
}

export function registerEmployeeRoutes(app: Express): void {
  app.get('/api/employees', requireAdmin(), async (_req, res) => {
    try {
      const employees = await storage.getAllEmployees();
      return res.json(employees.map(toPublicEmployeeProfile));
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.get('/api/employees/admin', requireAdmin(), async (_req, res) => {
    try {
      const [employeeList, settings] = await Promise.all([
        storage.getAllEmployees(),
        storage.getSettings(),
      ]);
      const includeScanId = settings?.barcodeEnabled !== false;
      return res.json(employeeList.map((employee) => toAdminEmployeeProfile(employee, includeScanId)));
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.get('/api/employees/deleted', requireAdmin(), async (_req, res) => {
    try {
      const [employeeList, settings] = await Promise.all([
        storage.getDeletedEmployees(),
        storage.getSettings(),
      ]);
      const includeScanId = settings?.barcodeEnabled !== false;
      return res.json(employeeList.map((employee) => toDeletedEmployeeProfile(employee, includeScanId)));
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.get('/api/employees/:id', requireAdmin(), async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) {
        return res.status(400).json({ message: '無效的員工編號' });
      }

      const [employee, settings] = await Promise.all([
        storage.getEmployeeById(id),
        storage.getSettings(),
      ]);
      if (!employee) {
        return res.status(404).json({ message: '找不到員工' });
      }

      const includeScanId = settings?.barcodeEnabled !== false;
      return res.json(toAdminEmployeeProfile(employee, includeScanId));
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.post('/api/employees', requireAdmin(), async (req, res) => {
    try {
      const validatedData = insertEmployeeSchema.parse(req.body);
      applyCreateEmployeeEncryptionFlag(req.body, validatedData);

      const employee = await storage.createEmployee(validatedData);
      return res.status(201).json(employee);
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.put('/api/employees/:id', requireAdmin(), async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) {
        return res.status(400).json({ message: '無效的員工編號' });
      }

      const validatedData = insertEmployeeSchema.partial().parse(req.body);
      applyUpdateEmployeeEncryptionFlag(req.body, validatedData);

      const [updatedEmployee, settings] = await Promise.all([
        storage.updateEmployee(id, validatedData),
        storage.getSettings(),
      ]);
      if (!updatedEmployee) {
        return res.status(404).json({ message: '找不到員工' });
      }

      const includeScanId = settings?.barcodeEnabled !== false;
      return res.json(toAdminEmployeeProfile(updatedEmployee, includeScanId));
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.patch('/api/employees/:id', requireAdmin(), async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) {
        return res.status(400).json({ message: '無效的員工編號' });
      }

      const filteredData = employeePatchSchema.parse(req.body);
      applyUpdateEmployeeEncryptionFlag(req.body, filteredData);

      if (Object.keys(filteredData).length === 0) {
        const currentEmployee = await storage.getEmployeeById(id);
        if (!currentEmployee) {
          return res.status(404).json({ message: '找不到員工' });
        }

        const settings = await storage.getSettings();
        const includeScanId = settings?.barcodeEnabled !== false;
        return res.json(toAdminEmployeeProfile(currentEmployee, includeScanId));
      }

      if (filteredData.specialLeaveUsedDates !== undefined) {
        const existingEmployee = await storage.getEmployeeById(id);
        if (existingEmployee) {
          const oldDates = Array.isArray(existingEmployee.specialLeaveUsedDates)
            ? existingEmployee.specialLeaveUsedDates.filter(
                (date): date is string => typeof date === 'string'
              )
            : [];
          const newDates = Array.isArray(filteredData.specialLeaveUsedDates)
            ? filteredData.specialLeaveUsedDates.filter(
                (date): date is string => typeof date === 'string'
              )
            : [];

          await syncEmployeeSpecialLeaveDates(
            id,
            existingEmployee.name,
            oldDates,
            newDates
          );
        }
      }

      const [updatedEmployee, settings] = await Promise.all([
        storage.updateEmployee(id, filteredData),
        storage.getSettings()
      ]);
      if (!updatedEmployee) {
        return res.status(404).json({ message: '找不到員工' });
      }

      const includeScanId = settings?.barcodeEnabled !== false;
      return res.json(toAdminEmployeeProfile(updatedEmployee, includeScanId));
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.delete('/api/employees/:id', requireAdmin(), async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) {
        return res.status(400).json({ message: '無效的員工編號' });
      }

      const success = await storage.deleteEmployee(id, resolveDeletedBy(req));
      if (!success) {
        return res.status(404).json({ message: '找不到員工' });
      }

      return res.status(204).end();
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.post('/api/employees/:id/restore', requireAdmin(), async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) {
        return res.status(400).json({ message: '無效的員工編號' });
      }

      const [restoredEmployee, settings] = await Promise.all([
        storage.restoreEmployee(id),
        storage.getSettings(),
      ]);
      if (!restoredEmployee) {
        return res.status(404).json({ message: '找不到員工' });
      }

      const includeScanId = settings?.barcodeEnabled !== false;
      return res.json({
        ...toAdminEmployeeProfile(restoredEmployee, includeScanId),
        requiresLineRebind: true,
        lineRestoreMode: 'rebind_required'
      });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  // Permanent purge: hard-delete employee and anonymize salary records.
  // Requires SUPER session + operator must confirm by supplying the exact employee name.
  app.delete('/api/employees/:id/purge', requireAdmin(PermissionLevel.SUPER), async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) {
        return res.status(400).json({ success: false, message: '無效的員工編號' });
      }

      const { confirmName } = req.body ?? {};
      if (typeof confirmName !== 'string' || confirmName.trim() === '') {
        return res.status(400).json({ success: false, message: '必須提供 confirmName 以確認刪除' });
      }

      // Fetch employee to verify it is in the recycle bin and name matches
      const employee = await storage.getEmployeeById(id);
      if (!employee) {
        return res.status(404).json({ success: false, message: '找不到員工' });
      }
      if (!employee.deletedAt) {
        return res.status(409).json({ success: false, message: '只能永久刪除已在回收桶中的員工' });
      }
      if (employee.name !== confirmName.trim()) {
        return res.status(422).json({ success: false, message: '員工姓名確認不符，請重新輸入' });
      }

      const result = await storage.purgeEmployee(id);
      if (!result.purged) {
        return res.status(404).json({ success: false, message: '員工刪除失敗' });
      }

      log.info(`Employee ${maskEmployeeIdentityForLog(employee.idNumber)} (id=${id}) permanently purged; ${result.anonymizedSalaryRecords} salary records anonymized`);
      return res.json({
        success: true,
        anonymizedSalaryRecords: result.anonymizedSalaryRecords,
      });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });
}
