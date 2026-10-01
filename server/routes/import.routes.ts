import type { Express } from 'express';
import { z } from 'zod';

import { strictLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/requireAdmin';
import { storage } from '../storage';
import { salaryRepository } from '../repositories/salaryRepository';
import { createLogger } from '../utils/logger';

import {
  parseAttendanceImportCsv,
  parseSalaryImportCsv,
  toImportedHistoryAttendanceData
} from './import-helpers';
import { handleRouteError } from './route-helpers';

const log = createLogger('import');
const importTargetSchema = z.object({
  employeeId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  recordId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
});
const importMonthSchema = z.object({
  salaryYear: z.number().int().min(1900).max(9999),
  salaryMonth: z.number().int().min(1).max(12)
});

export function registerImportRoutes(app: Express): void {
  app.post('/api/admin/import/attendance', strictLimiter, requireAdmin(), async (req, res) => {
    try {
      const csvContent = req.body.csvContent;
      if (!csvContent || typeof csvContent !== 'string') {
        return res.status(400).json({ success: false, message: '未提供CSV內容' });
      }

      const { rows, result } = parseAttendanceImportCsv(csvContent);

      for (const row of rows) {
        await storage.createTemporaryAttendance(row);
      }

      return res.json({
        message: `匯入完成: 成功 ${result.successCount} 筆，失敗 ${result.failCount} 筆`,
        ...result
      });
    } catch (err) {
      log.error('匯入考勤記錄時出錯:', err);
      return handleRouteError(err, res);
    }
  });

  app.post('/api/admin/import/salary-record', strictLimiter, requireAdmin(), async (req, res) => {
    try {
      const csvContent = req.body.csvContent;
      if (!csvContent || typeof csvContent !== 'string') {
        return res.status(400).json({ success: false, message: '未提供CSV內容' });
      }

      const { employeeId, recordId } = importTargetSchema.parse(req.body);
      let salaryRecord: ReturnType<typeof parseSalaryImportCsv>;
      try {
        salaryRecord = parseSalaryImportCsv(csvContent);
      } catch {
        return res.status(400).json({ success: false, message: 'Invalid salary CSV format.' });
      }
      importMonthSchema.parse(salaryRecord);
      if ((salaryRecord.snapshotRevision ?? 0) > 0) {
        return res.status(409).json({ success: false, code: 'CORRECTION_REQUIRED', message: 'Revised salary snapshots cannot recreate payroll. Use the salary correction workflow to preserve its audit history.' });
      }
      const historicalAttendanceData = toImportedHistoryAttendanceData(salaryRecord.attendanceData);
      const monthPrefix = `${salaryRecord.salaryYear}/${String(salaryRecord.salaryMonth).padStart(2, '0')}/`;
      if (historicalAttendanceData.some((record) => !record.date.startsWith(monthPrefix))) {
        return res.status(400).json({ success: false, message: 'Imported attendance must belong to the salary month.' });
      }

      let existingRecord: Awaited<ReturnType<typeof salaryRepository.getSalaryRecordById>>;
      let targetEmployee: Awaited<ReturnType<typeof storage.getEmployeeById>>;
      if (recordId !== undefined) {
        existingRecord = await salaryRepository.getSalaryRecordById(recordId);
        if (!existingRecord) {
          return res.status(404).json({ success: false, message: 'Salary record not found.' });
        }
        if (
          existingRecord.salaryYear !== salaryRecord.salaryYear ||
          existingRecord.salaryMonth !== salaryRecord.salaryMonth ||
          (employeeId !== undefined && existingRecord.employeeId !== employeeId)
        ) {
          return res.status(409).json({
            success: false, code: 'SALARY_IMPORT_TARGET_MISMATCH',
            message: 'The selected salary record does not match the imported month or employee.'
          });
        }
      } else if (employeeId !== undefined) {
        targetEmployee = await storage.getEmployeeById(employeeId);
        if (!targetEmployee) {
          return res.status(404).json({ success: false, message: 'Employee not found.' });
        }
        existingRecord = await salaryRepository.getSalaryRecordByYearMonthEmployee(
          salaryRecord.salaryYear, salaryRecord.salaryMonth, employeeId
        );
      } else {
        const monthRecords = await salaryRepository.getSalaryRecordsByYearMonth(salaryRecord.salaryYear, salaryRecord.salaryMonth);
        if (monthRecords.length > 1 || monthRecords[0]?.employeeId != null) {
          return res.status(409).json({
            success: false, code: 'SALARY_IMPORT_TARGET_REQUIRED',
            message: 'Select an employee or salary record before importing over existing payroll.'
          });
        }
        existingRecord = monthRecords[0];
      }

      const scopedEmployeeId = existingRecord?.employeeId ?? employeeId;
      if (salaryRecord.employeeId !== undefined && salaryRecord.employeeId !== scopedEmployeeId) {
        return res.status(409).json({ success: false, code: 'SALARY_IMPORT_TARGET_MISMATCH', message: 'The CSV employee does not match the explicitly selected import target.' });
      }
      if (existingRecord) {
        return res.status(409).json({ success: false, code: 'CORRECTION_REQUIRED', message: 'Existing settled salary records cannot be overwritten by CSV. Use the salary correction workflow.' });
      }
      const { snapshotRevision: _sourceRevision, ...snapshot } = salaryRecord;
      const salaryRecordPayload = {
        ...snapshot,
        holidayCalculationBaseSalary: snapshot.holidayCalculationBaseSalary ?? null,
        ...(scopedEmployeeId != null ? { employeeId: scopedEmployeeId } : {}),
        ...(targetEmployee ? { employeeName: targetEmployee.name } : {}),
        attendanceData: historicalAttendanceData.map((record) => ({
          ...record, employeeId: scopedEmployeeId ?? null, holidayId: record.holidayId ?? null,
          holidayType: record.holidayType ?? null, createdAt: record.createdAt ?? null,
        }))
      };

      const createdRecord = await salaryRepository.createSalaryRecord(salaryRecordPayload);
      return res.json({
        success: true,
        message: `成功匯入 ${salaryRecord.salaryYear}年${salaryRecord.salaryMonth}月 的薪資記錄，包含 ${salaryRecord.attendanceData.length} 筆考勤記錄`,
        record: createdRecord
      });
    } catch (err) {
      if (err instanceof z.ZodError) return handleRouteError(err, res);
      const conflict = err as { code?: unknown; status?: unknown; statusCode?: unknown } | null;
      if (conflict && (conflict.code === 'CORRECTION_REQUIRED' || conflict.status === 409 || conflict.statusCode === 409)) {
        return res.status(409).json({
          success: false, code: 'CORRECTION_REQUIRED',
          message: 'This salary record has revisions. Use the salary correction workflow instead of importing over it.'
        });
      }
      log.error('Salary record import failed');
      return handleRouteError(new Error('Salary record import failed'), res);
    }
  });
}
