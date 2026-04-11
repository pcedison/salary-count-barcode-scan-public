import type { Express } from 'express';

import { insertSalaryRecordSchema, type InsertSalaryRecord, type Settings } from '@shared/schema';

import { recordLatency } from '../observability/runtimeMetrics';
import { requireAdmin } from '../middleware/requireAdmin';
import { storage } from '../storage';
import { createLogger } from '../utils/logger';
import type { OvertimeHours } from '../utils/salaryCalculator';

import {
  deriveHolidayPayBase,
  mergeSalaryDeductions,
  normalizeSalaryDeductions,
  shouldRecalculateSalary,
  toCalculationSettings,
} from './salary-helpers';
import { handleRouteError, parseNumericId } from './route-helpers';

const log = createLogger('salary');

function parseBoundedPagination(queryPage: unknown, queryLimit: unknown) {
  const page = Math.max(1, parseInt(String(queryPage ?? '1'), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(queryLimit ?? '50'), 10) || 50));

  return { page, limit };
}

async function loadSalaryCalculator() {
  return import('../utils/salaryCalculator');
}

async function loadAttendanceForSalaryMonth(
  employeeId: number | null | undefined,
  salaryYear: number,
  salaryMonth: number
) {
  if (!employeeId) {
    return [];
  }

  const attendanceLoader = storage.getTemporaryAttendanceByEmployeeAndMonth;
  const attendance =
    typeof attendanceLoader === 'function'
      ? await attendanceLoader.call(storage, employeeId, salaryYear, salaryMonth)
      : (await storage.getTemporaryAttendance()).filter((record) => {
          const normalizedDate = String(record.date ?? '').replace(/\//g, '-');
          return (
            record.employeeId === employeeId &&
            normalizedDate.startsWith(`${salaryYear}-${String(salaryMonth).padStart(2, '0')}-`)
          );
        });

  return attendance.map((record) => ({
    ...record,
    employeeId: record.employeeId ?? undefined,
    clockOut: record.clockOut ?? undefined,
  }));
}

function logHolidayAdjustmentSummary(
  employeeId: number | null | undefined,
  salaryYear: number,
  salaryMonth: number,
  holidayAdjustments: {
    sickLeaveDays: number;
    sickLeaveDeduction: number;
    personalLeaveDays: number;
    personalLeaveDeduction: number;
    typhoonLeaveDays: number;
    typhoonLeaveDeduction: number;
    workedHolidayDays: number;
    workedHolidayPay: number;
  }
) {
  if (
    holidayAdjustments.sickLeaveDays === 0 &&
    holidayAdjustments.personalLeaveDays === 0 &&
    holidayAdjustments.typhoonLeaveDays === 0 &&
    holidayAdjustments.workedHolidayDays === 0
  ) {
    return;
  }

  log.info(
    `Holiday adjustments for employee ${employeeId || 'unknown'} in ${salaryYear}-${String(salaryMonth).padStart(2, '0')}:`,
    `sick leave ${holidayAdjustments.sickLeaveDays} days, deduction ${holidayAdjustments.sickLeaveDeduction}`,
    `personal leave ${holidayAdjustments.personalLeaveDays} days, deduction ${holidayAdjustments.personalLeaveDeduction}`,
    `typhoon leave ${holidayAdjustments.typhoonLeaveDays} days, deduction ${holidayAdjustments.typhoonLeaveDeduction}`,
    `worked holiday ${holidayAdjustments.workedHolidayDays} days, pay ${holidayAdjustments.workedHolidayPay}`
  );
}

async function buildCalculatedSalaryRecord(
  draft: InsertSalaryRecord,
  settings: Settings,
  options?: {
    previousRecord?: {
      employeeId?: number | null;
      salaryYear?: number | null;
      salaryMonth?: number | null;
      totalHolidayPay?: number | null;
      baseSalary?: number | null;
    };
  }
): Promise<InsertSalaryRecord> {
  const { calculateSalary, calculateHolidayPayAdjustments } = await loadSalaryCalculator();

  const calculatorAttendanceRecords = await loadAttendanceForSalaryMonth(
    draft.employeeId,
    draft.salaryYear,
    draft.salaryMonth
  );

  const holidayAdjustments = calculateHolidayPayAdjustments(calculatorAttendanceRecords, draft.baseSalary);
  const allDeductions = mergeSalaryDeductions(
    normalizeSalaryDeductions(draft.deductions),
    holidayAdjustments.deductionItems
  );
  const totalDeductions = allDeductions.reduce((sum, deduction) => sum + (deduction.amount || 0), 0);

  const previousEmployeeId = options?.previousRecord?.employeeId;
  const previousSalaryYear = options?.previousRecord?.salaryYear || draft.salaryYear;
  const previousSalaryMonth = options?.previousRecord?.salaryMonth || draft.salaryMonth;
  const previousRelevantAttendance = options?.previousRecord
    ? previousEmployeeId === draft.employeeId &&
      previousSalaryYear === draft.salaryYear &&
      previousSalaryMonth === draft.salaryMonth
      ? calculatorAttendanceRecords
      : await loadAttendanceForSalaryMonth(previousEmployeeId, previousSalaryYear, previousSalaryMonth)
    : [];
  const previousWorkedHolidayPay = options?.previousRecord
    ? calculateHolidayPayAdjustments(
        previousRelevantAttendance,
        options.previousRecord.baseSalary || draft.baseSalary
      ).workedHolidayPay || 0
    : 0;

  const holidayPayBase = deriveHolidayPayBase({
    explicitHolidayPay: draft.totalHolidayPay,
    storedTotalHolidayPay: options?.previousRecord?.totalHolidayPay,
    previousWorkedHolidayPay,
  });
  const totalHolidayPay = holidayPayBase + (holidayAdjustments.workedHolidayPay || 0);

  const salaryResult = calculateSalary(
    draft.salaryYear,
    draft.salaryMonth,
    {
      totalOT1Hours: draft.totalOT1Hours || 0,
      totalOT2Hours: draft.totalOT2Hours || 0,
    } satisfies OvertimeHours,
    draft.baseSalary,
    totalDeductions,
    toCalculationSettings(settings),
    totalHolidayPay,
    draft.welfareAllowance ?? undefined,
    draft.housingAllowance || 0,
    draft.employeeId || 0
  );

  logHolidayAdjustmentSummary(draft.employeeId, draft.salaryYear, draft.salaryMonth, holidayAdjustments);

  return {
    ...draft,
    deductions: allDeductions,
    totalOT1Hours: salaryResult.totalOT1Hours,
    totalOT2Hours: salaryResult.totalOT2Hours,
    totalOvertimePay: salaryResult.totalOvertimePay,
    totalHolidayPay,
    grossSalary: salaryResult.grossSalary,
    totalDeductions,
    netSalary: salaryResult.netSalary,
  };
}

export function registerSalaryRoutes(app: Express): void {
  app.get('/api/salary-records', requireAdmin(), async (req, res) => {
    const startedAt = Date.now();

    try {
      const { page, limit } = parseBoundedPagination(req.query.page, req.query.limit);
      const { rows, total } = await storage.getAllSalaryRecordsPage(page, limit);
      return res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (err) {
      return handleRouteError(err, res);
    } finally {
      recordLatency('api.salary-records.list', Date.now() - startedAt);
    }
  });

  app.get('/api/salary-records/:id', requireAdmin(), async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) {
        return res.status(400).json({ message: 'Invalid ID' });
      }

      const record = await storage.getSalaryRecordById(id);
      if (!record) {
        return res.status(404).json({ message: 'Salary record not found' });
      }

      return res.json(record);
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.post('/api/salary-records', requireAdmin(), async (req, res) => {
    try {
      const settings = await storage.getSettings();
      if (!settings) {
        return res.status(500).json({ message: 'Settings must be configured before creating salary records.' });
      }

      const validatedData = insertSalaryRecordSchema.parse(req.body);
      const finalData = await buildCalculatedSalaryRecord(validatedData, settings);
      const record = await storage.createSalaryRecord(finalData);

      return res.status(201).json(record);
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.patch('/api/salary-records/:id', requireAdmin(), async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) {
        return res.status(400).json({ message: 'Invalid ID' });
      }

      const settings = await storage.getSettings();
      if (!settings) {
        return res.status(500).json({ message: 'Settings must be configured before updating salary records.' });
      }

      const existingRecord = await storage.getSalaryRecordById(id);
      if (!existingRecord) {
        return res.status(404).json({ message: 'Salary record not found' });
      }

      const validatedData = insertSalaryRecordSchema.partial().parse(req.body);
      // x-force-update: true means "accept my values as-is and skip server recalculation".
      const skipRecalculation = req.headers['x-force-update'] === 'true';
      const updateData: Partial<InsertSalaryRecord> = { ...validatedData };

      if (shouldRecalculateSalary(updateData, skipRecalculation)) {
        const mergedData = {
          ...existingRecord,
          ...updateData,
        } as InsertSalaryRecord;

        const recalculatedRecord = await buildCalculatedSalaryRecord(mergedData, settings, {
          previousRecord: {
            employeeId: existingRecord.employeeId,
            salaryYear: existingRecord.salaryYear,
            salaryMonth: existingRecord.salaryMonth,
            totalHolidayPay: existingRecord.totalHolidayPay,
            baseSalary: existingRecord.baseSalary,
          },
        });

        updateData.deductions = recalculatedRecord.deductions;
        updateData.totalOT1Hours = recalculatedRecord.totalOT1Hours;
        updateData.totalOT2Hours = recalculatedRecord.totalOT2Hours;
        updateData.totalOvertimePay = recalculatedRecord.totalOvertimePay;
        updateData.totalHolidayPay = recalculatedRecord.totalHolidayPay;
        updateData.grossSalary = recalculatedRecord.grossSalary;
        updateData.totalDeductions = recalculatedRecord.totalDeductions;
        updateData.netSalary = recalculatedRecord.netSalary;
      }

      const record = await storage.updateSalaryRecord(id, updateData);
      if (!record) {
        return res.status(404).json({ message: 'Salary record not found' });
      }

      return res.json(record);
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.delete('/api/salary-records/:id', requireAdmin(), async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) {
        return res.status(400).json({ message: 'Invalid ID' });
      }

      const deleted = await storage.deleteSalaryRecord(id);
      if (!deleted) {
        return res.status(404).json({ message: 'Salary record not found' });
      }

      return res.status(204).end();
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    app.get('/api/test-salary-calculation', requireAdmin(), async (_req, res) => {
      try {
        const settings = await storage.getSettings();
        if (!settings) {
          return res.status(404).json({ message: 'Settings not found' });
        }

        const { calculateSalary, calculateOvertimePay } = await loadSalaryCalculator();

        const march2025Result = calculateSalary(
          2025,
          3,
          { totalOT1Hours: 40, totalOT2Hours: 21 },
          settings.baseMonthSalary,
          5401,
          settings,
          0,
          settings.welfareAllowance,
          0
        );

        const april2025Result = calculateSalary(
          2025,
          4,
          { totalOT1Hours: 42, totalOT2Hours: 13 },
          settings.baseMonthSalary,
          5401,
          settings,
          0,
          settings.welfareAllowance,
          0
        );

        const calculationSettings = toCalculationSettings(settings);
        const marchOvertimeHours = { totalOT1Hours: 40, totalOT2Hours: 21 };
        const marchRawOvertimePay = calculateOvertimePay(marchOvertimeHours, calculationSettings);
        const marchFinalOvertimePay = march2025Result.totalOvertimePay;

        const aprilOvertimeHours = { totalOT1Hours: 42, totalOT2Hours: 13 };
        const aprilRawOvertimePay = calculateOvertimePay(aprilOvertimeHours, calculationSettings);
        const aprilFinalOvertimePay = april2025Result.totalOvertimePay;

        return res.json({
          settings: {
            baseHourlyRate: settings.baseHourlyRate,
            ot1Multiplier: settings.ot1Multiplier,
            ot2Multiplier: settings.ot2Multiplier,
            baseMonthSalary: settings.baseMonthSalary,
            welfareAllowance: settings.welfareAllowance,
          },
          march2025: {
            ...march2025Result,
            rawOvertimePay: marchRawOvertimePay,
            finalOvertimePay: marchFinalOvertimePay,
            expectedNetSalary: 36248,
            difference: 36248 - march2025Result.netSalary,
          },
          april2025: {
            ...april2025Result,
            rawOvertimePay: aprilRawOvertimePay,
            finalOvertimePay: aprilFinalOvertimePay,
            expectedNetSalary: 35054,
            difference: 35054 - april2025Result.netSalary,
          },
          notes: 'This debug route is intended for non-production verification of salary calculations.',
        });
      } catch (err) {
        return handleRouteError(err, res);
      }
    });
  }

  app.get('/api/salary-records/:id/pdf', requireAdmin(), async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) {
        return res.status(400).json({ message: 'Invalid ID' });
      }

      const record = await storage.getSalaryRecordById(id);
      if (!record) {
        return res.status(404).json({ message: 'Salary record not found' });
      }

      return res.redirect(`/print-salary?id=${id}`);
    } catch (err) {
      return handleRouteError(err, res);
    }
  });
}
