import type { Express } from 'express';

import { strictLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/requireAdmin';
import { storage } from '../storage';
import { createLogger } from '../utils/logger';

import {
  parseAttendanceImportCsv,
  parseSalaryImportCsv,
  toImportedHistoryAttendanceData
} from './import-helpers';
import { handleRouteError } from './route-helpers';

const log = createLogger('import');

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

      const salaryRecord = parseSalaryImportCsv(csvContent);
      const historicalAttendanceData = toImportedHistoryAttendanceData(salaryRecord.attendanceData);
      const salaryRecordPayload = {
        ...salaryRecord,
        attendanceData: historicalAttendanceData
      };
      const existingRecord = await storage.getSalaryRecordByYearMonth(
        salaryRecord.salaryYear,
        salaryRecord.salaryMonth
      );

      if (existingRecord) {
        const updatedRecord = await storage.updateSalaryRecord(existingRecord.id, salaryRecordPayload);
        return res.json({
          success: true,
          message: `成功更新 ${salaryRecord.salaryYear}年${salaryRecord.salaryMonth}月 的薪資記錄，包含 ${salaryRecord.attendanceData.length} 筆考勤記錄`,
          record: updatedRecord
        });
      }

      const createdRecord = await storage.createSalaryRecord(salaryRecordPayload);
      return res.json({
        success: true,
        message: `成功匯入 ${salaryRecord.salaryYear}年${salaryRecord.salaryMonth}月 的薪資記錄，包含 ${salaryRecord.attendanceData.length} 筆考勤記錄`,
        record: createdRecord
      });
    } catch (err) {
      log.error('匯入薪資記錄時出錯:', err);
      return handleRouteError(err, res);
    }
  });
}
