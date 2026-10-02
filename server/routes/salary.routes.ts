import type { Express } from 'express';

import { insertSalaryRecordSchema, type InsertSalaryRecord, type Settings, type TemporaryAttendance } from '@shared/schema';
import { z } from 'zod';
import { buildHistorySalaryEdit } from '../services/historySalaryEdit';
import { payrollHash } from '../services/payrollPreviewToken';
import { PayrollCorrectionError } from '../services/payrollCorrection';
import { correctionActor, registerPayrollCorrectionRoutes, requirePayrollWrite } from './payrollCorrection.routes';

import { recordLatency } from '../observability/runtimeMetrics';
import { requireAdmin } from '../middleware/requireAdmin';
import { storage } from '../storage';
import { salaryRepository } from '../repositories/salaryRepository';
import {
  normalizeSalaryPrintRecordIds,
  verifySalaryPrintToken,
} from '../services/salaryPrintToken';
import { createLogger } from '../utils/logger';
import type { OvertimeHours } from '../utils/salaryCalculator';
import { captureSettlementOvertime } from '@shared/utils/archivedOvertime';

import {
  deriveHolidayPayBase,
  mergeSalaryDeductions,
  normalizeSalaryDeductions,
  toCalculationSettings,
} from './salary-helpers';
import { handleRouteError, parseNumericId } from './route-helpers';

const log = createLogger('salary');
const money = z.number().finite().nonnegative();
const deductionItem = z.object({ name: z.string().trim().min(1).max(100), amount: money,
  description: z.string().max(1000).nullable().optional(),
}).strict();
const allowanceItem = deductionItem.extend({ description: z.string().max(1000).optional() }).strict();
const manualEditSchema = insertSalaryRecordSchema.partial().extend({
  baseSalary: money.optional(), housingAllowance: money.nullable().optional(),
  deductions: z.array(deductionItem).max(100).nullable().optional(),
  allowances: z.array(allowanceItem).max(100).nullable().optional(),
  specialLeaveInfo: z.object({
    usedDays: money, usedDates: z.array(z.string().max(10)).max(366),
    cashDays: money, cashAmount: money,
    cashMonth: z.string().max(10).optional(), notes: z.string().max(1000).optional(),
  }).strict().nullable().optional(),
  revision: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(1000),
  paymentHandling: z.enum(['unpaid', 'paid_adjustment', 'unknown_adjustment']), idempotencyKey: z.string().uuid(),
}).strict();

function parseBoundedPagination(queryPage: unknown, queryLimit: unknown) {
  const page = Math.max(1, parseInt(String(queryPage ?? '1'), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(queryLimit ?? '50'), 10) || 50));

  return { page, limit };
}

function parseOptionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '' || value === 'all') {
    return undefined;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== 'all' ? trimmed : undefined;
}

function parseSalaryRecordFilters(query: Record<string, unknown>) {
  const filters = {
    employeeId: parseOptionalPositiveInteger(query.employeeId),
    salaryYear: parseOptionalPositiveInteger(query.salaryYear ?? query.year),
    salaryMonth: parseOptionalPositiveInteger(query.salaryMonth ?? query.month),
    search: parseOptionalString(query.search)
  };

  return Object.values(filters).some(value => value !== undefined) ? filters : undefined;
}

function parseSalaryRecordYearFilters(query: Record<string, unknown>) {
  const filters = {
    employeeId: parseOptionalPositiveInteger(query.employeeId),
    salaryMonth: parseOptionalPositiveInteger(query.salaryMonth ?? query.month),
    search: parseOptionalString(query.search)
  };

  return Object.values(filters).some(value => value !== undefined) ? filters : undefined;
}

function parsePrintRecordIds(rawIds: unknown): number[] {
  if (Array.isArray(rawIds)) {
    return normalizeSalaryPrintRecordIds(rawIds.flatMap((value) => String(value).split(',')));
  }

  return normalizeSalaryPrintRecordIds(String(rawIds ?? '').split(','));
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

  log.info('Holiday adjustment calculation completed', {
    salaryYear, salaryMonth,
    hasLeaveAdjustment: holidayAdjustments.sickLeaveDays > 0 || holidayAdjustments.personalLeaveDays > 0 || holidayAdjustments.typhoonLeaveDays > 0,
    hasWorkedHolidayAdjustment: holidayAdjustments.workedHolidayDays > 0,
  });
}

export type CalculatedSalaryRecord = InsertSalaryRecord & { holidayCalculationBaseSalary: number };

export async function buildCalculatedSalaryRecord(
  draft: InsertSalaryRecord,
  settings: Settings,
  options?: {
    attendanceRecords?: TemporaryAttendance[];
    previousRecord?: {
      employeeId?: number | null;
      salaryYear?: number | null;
      salaryMonth?: number | null;
      totalHolidayPay?: number | null;
      baseSalary?: number | null;
    };
  }
): Promise<CalculatedSalaryRecord> {
  const { calculateSalary, calculateHolidayPayAdjustments } = await loadSalaryCalculator();

  const calculatorAttendanceRecords = options?.attendanceRecords?.map(record => ({ ...record, employeeId: record.employeeId ?? undefined, clockOut: record.clockOut ?? undefined })) ?? await loadAttendanceForSalaryMonth(
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
  const specialLeaveCashAmount =
    typeof draft.specialLeaveInfo?.cashAmount === 'number' ? draft.specialLeaveInfo.cashAmount : 0;

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
    holidayCalculationBaseSalary: draft.baseSalary,
    deductions: allDeductions,
    totalOT1Hours: salaryResult.totalOT1Hours,
    totalOT2Hours: salaryResult.totalOT2Hours,
    attendanceData: captureSettlementOvertime({ ...draft,
      totalOT1Hours: salaryResult.totalOT1Hours, totalOT2Hours: salaryResult.totalOT2Hours }),
    totalOvertimePay: salaryResult.totalOvertimePay,
    totalHolidayPay,
    grossSalary: salaryResult.grossSalary + specialLeaveCashAmount,
    totalDeductions,
    netSalary: salaryResult.netSalary + specialLeaveCashAmount,
  };
}

export function registerSalaryRoutes(app: Express): void {
  registerPayrollCorrectionRoutes(app);
  app.get('/api/salary-records/finalized-months', requireAdmin(), async (_req, res) => {
    try { return res.json({ data: await salaryRepository.getFinalizedSalaryMonths() }); }
    catch (err) { return handleRouteError(err, res); }
  });
  app.get('/api/salary-records', requireAdmin(), async (req, res) => {
    const startedAt = Date.now();

    try {
      const { page, limit } = parseBoundedPagination(req.query.page, req.query.limit);
      const filters = z.object({
        salaryYear: z.coerce.number().int().min(1900).max(9999).optional(),
        salaryMonth: z.coerce.number().int().min(1).max(12).optional(),
        employeeId: z.coerce.number().int().positive().optional(),
        search: z.string().trim().max(100).optional(),
      }).parse({ salaryYear: req.query.salaryYear ?? req.query.year, salaryMonth: req.query.salaryMonth ?? req.query.month,
        employeeId: req.query.employeeId, search: req.query.search });
      const { rows, total } = await salaryRepository.getAllSalaryRecordsPage(page, limit, filters);
      return res.json({ data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (err) {
      return handleRouteError(err, res);
    } finally {
      recordLatency('api.salary-records.list', Date.now() - startedAt);
    }
  });

  app.get('/api/salary-records/years', requireAdmin(), async (req, res) => {
    try { return res.json({ data: await salaryRepository.getSalaryRecordYears(parseSalaryRecordYearFilters(req.query)) }); }
    catch (error) { return handleRouteError(error, res); }
  });

  app.get('/api/salary-records/print-batch', async (req, res) => {
    try {
      const ids = parsePrintRecordIds(req.query.ids);
      if (ids.length === 0 || ids.length > 100) {
        return res.status(400).json({ message: 'No salary record IDs provided' });
      }

      if (!verifySalaryPrintToken(ids, req.query.token)) {
        return res.status(401).json({ message: 'Invalid or expired salary print token' });
      }

      const loaded = await salaryRepository.getSalaryRecordsByIds(ids);
      const recordMap = new Map(loaded.map(record => [record.id, record]));
      const records = ids.map(id => recordMap.get(id));
      if (records.some(record => !record)) return res.status(404).json({ message: 'A salary record was not found.' });

      return res.json({ records });
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.get('/api/salary-records/:id', requireAdmin(), async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) {
        return res.status(400).json({ message: 'Invalid ID' });
      }

      const record = await salaryRepository.getSalaryRecordById(id);
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
      const record = await salaryRepository.createSalaryRecord(finalData);

      return res.status(201).json(record);
    } catch (err) {
      return handleRouteError(err, res);
    }
  });

  app.patch('/api/salary-records/:id', requireAdmin(), requirePayrollWrite, async (req, res) => {
    try {
      const id = parseNumericId(req.params.id);
      if (id === null) {
        return res.status(400).json({ message: 'Invalid ID' });
      }

      if (req.headers['x-force-update']) throw new PayrollCorrectionError(400, 'FORCE_UPDATE_REMOVED', 'Client-calculated salary overrides are no longer supported.');
      const request = manualEditSchema.parse(req.body);
      const { idempotencyKey, revision, reason, paymentHandling, ...values } = request;
      const actor = correctionActor(req);
      const result = await salaryRepository.commitSalaryCorrection(id, { ...actor, idempotencyKey, requestHash: payrollHash(request), previewTokenHash: payrollHash({ kind: 'manual-edit', revision }) }, record => {
        if ((record.revision ?? 0) !== revision) throw new PayrollCorrectionError(409, 'REVISION_CONFLICT', 'Salary record changed; reopen the editor before saving.');
        return buildHistorySalaryEdit(record, values, reason, paymentHandling);
      });
      return res.json(result.record);
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

      const deleted = await salaryRepository.deleteSalaryRecord(id);
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

      const record = await salaryRepository.getSalaryRecordById(id);
      if (!record) {
        return res.status(404).json({ message: 'Salary record not found' });
      }

      return res.redirect(`/print-salary?id=${id}`);
    } catch (err) {
      return handleRouteError(err, res);
    }
  });
}
