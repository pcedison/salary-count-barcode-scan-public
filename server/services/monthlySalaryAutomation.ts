import type {
  Employee,
  InsertSalaryRecord,
  MonthlySalaryRun,
  SalaryRecord,
  Settings,
  TemporaryAttendance,
} from '@shared/schema';
import { calculateDailyOvertimeSummary } from '@shared/utils/salaryMath';

import {
  getSalaryAutomationConfig,
  isSalaryEmailConfigured,
  type SalaryAutomationConfig,
} from '../config/salaryAutomation';
import { storage } from '../storage';
import { createLogger } from '../utils/logger';
import { buildCalculatedSalaryRecord } from '../routes/salary.routes';
import { sendMonthlySalaryEmail } from './salaryEmail';
import { generateMonthlySalaryPdf, type SalaryReportTarget } from './salaryPdf';

const log = createLogger('salary-automation');

export interface MonthlySalaryAutomationOptions {
  target?: SalaryReportTarget;
  now?: Date;
  dryRun?: boolean;
  force?: boolean;
  sendEmail?: boolean;
  config?: SalaryAutomationConfig;
}

export interface MonthlySalaryAutomationResult {
  target: SalaryReportTarget;
  status: 'succeeded' | 'skipped' | 'failed' | 'dry-run';
  reason?: string;
  run?: MonthlySalaryRun;
  calculatedRecords: InsertSalaryRecord[];
  persistedRecords: SalaryRecord[];
  skippedEmployees: Array<{ employeeId: number; employeeName: string; reason: string }>;
  pdfPath?: string;
  emailRecipients: string[];
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function getLocalDateParts(date: Date, timeZone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

export function getPreviousSalaryMonthTarget(
  now = new Date(),
  timeZone = getSalaryAutomationConfig().timeZone
): SalaryReportTarget {
  const parts = getLocalDateParts(now, timeZone);
  if (parts.month === 1) {
    return { year: parts.year - 1, month: 12 };
  }

  return { year: parts.year, month: parts.month - 1 };
}

export function shouldRunMonthlySalaryAutomation(
  now = new Date(),
  config = getSalaryAutomationConfig()
): boolean {
  if (!config.enabled) {
    return false;
  }

  const parts = getLocalDateParts(now, config.timeZone);
  if (parts.day > 1) {
    return true;
  }

  return parts.hour > config.runHour || (parts.hour === config.runHour && parts.minute >= config.runMinute);
}

function getRunKey(target: SalaryReportTarget): string {
  return `${target.year}-${String(target.month).padStart(2, '0')}`;
}

function isActivePayrollEmployee(employee: Employee): boolean {
  return employee.active !== false && !employee.deletedAt;
}

function hasUsableClockTimes(record: TemporaryAttendance): boolean {
  return Boolean(
    record.clockIn &&
      record.clockOut &&
      record.clockIn !== '--:--' &&
      record.clockOut !== '--:--'
  );
}

function sortAttendance(attendance: TemporaryAttendance[]): TemporaryAttendance[] {
  return [...attendance].sort((a, b) => {
    const dateA = new Date(String(a.date ?? '').replace(/\//g, '-')).getTime();
    const dateB = new Date(String(b.date ?? '').replace(/\//g, '-')).getTime();
    return dateA - dateB;
  });
}

function getSpecialLeaveInfoForMonth(employee: Employee, settings: Settings, target: SalaryReportTarget) {
  const usedDates = employee.specialLeaveUsedDates || [];
  const monthPrefix = `${target.year}-${String(target.month).padStart(2, '0')}`;
  const monthlyUsedDates = usedDates
    .map((date) => date.replace(/\//g, '-'))
    .filter((date) => date.startsWith(monthPrefix));

  const cashMonth = employee.specialLeaveCashMonth || '';
  const isCashMonth =
    cashMonth === `${target.year}年${target.month}月` ||
    cashMonth === `${target.year}-${String(target.month).padStart(2, '0')}`;
  const cashDays = isCashMonth ? employee.specialLeaveCashDays || 0 : 0;
  const cashAmount = cashDays * Math.round(settings.baseMonthSalary / 30);

  if (monthlyUsedDates.length === 0 && cashDays === 0) {
    return undefined;
  }

  return {
    usedDays: monthlyUsedDates.length,
    usedDates: monthlyUsedDates,
    cashDays,
    cashAmount,
    notes: employee.specialLeaveNotes || undefined,
  };
}

function buildSalaryDraftForEmployee(
  employee: Employee,
  attendance: TemporaryAttendance[],
  settings: Settings,
  target: SalaryReportTarget
): InsertSalaryRecord {
  const sortedAttendance = sortAttendance(attendance);
  let totalOT1Hours = 0;
  let totalOT2Hours = 0;

  for (const record of sortedAttendance) {
    if (record.isHoliday || !hasUsableClockTimes(record)) {
      continue;
    }

    const summary = calculateDailyOvertimeSummary(record.clockIn, record.clockOut || '', {
      baseHourlyRate: settings.baseHourlyRate,
      ot1Multiplier: settings.ot1Multiplier,
      ot2Multiplier: settings.ot2Multiplier,
      baseMonthSalary: settings.baseMonthSalary,
      welfareAllowance: settings.welfareAllowance ?? 0,
    });
    totalOT1Hours += summary.ot1;
    totalOT2Hours += summary.ot2;
  }

  const specialLeaveInfo = getSpecialLeaveInfoForMonth(employee, settings, target);
  const allowances = settings.allowances ?? [];
  const welfareAllowance = settings.welfareAllowance ?? 0;
  const deductions = settings.deductions ?? [];

  return {
    employeeId: employee.id,
    employeeName: employee.name,
    salaryYear: target.year,
    salaryMonth: target.month,
    baseSalary: settings.baseMonthSalary,
    housingAllowance: 0,
    welfareAllowance,
    allowances,
    totalOT1Hours,
    totalOT2Hours,
    totalOvertimePay: 0,
    holidayDays: sortedAttendance.filter((record) => record.holidayType === 'worked').length,
    holidayDailySalary: Math.round(settings.baseMonthSalary / 30),
    totalHolidayPay: 0,
    grossSalary: 0,
    deductions,
    totalDeductions: deductions.reduce((sum, deduction) => sum + (deduction.amount || 0), 0),
    netSalary: 0,
    attendanceData: sortedAttendance,
    specialLeaveInfo,
  };
}

async function acquireRun(
  target: SalaryReportTarget,
  options: MonthlySalaryAutomationOptions,
  config: SalaryAutomationConfig
): Promise<{ run?: MonthlySalaryRun; skipReason?: string }> {
  if (options.dryRun) {
    return {};
  }

  const existingRun = await storage.getMonthlySalaryRun(target.year, target.month);
  if (existingRun?.status === 'succeeded' && !options.force) {
    return { run: existingRun, skipReason: 'monthly salary run already succeeded' };
  }

  if (existingRun?.status === 'running' && !options.force) {
    return { run: existingRun, skipReason: 'monthly salary run is already running' };
  }

  if (existingRun) {
    const updatedRun = await storage.updateMonthlySalaryRun(existingRun.id, {
      status: 'running',
      recordCount: 0,
      skippedCount: 0,
      pdfPath: null,
      emailTo: config.emailRecipients,
      emailSentAt: null,
      errorMessage: null,
      completedAt: null,
    });
    return { run: updatedRun ?? existingRun };
  }

  const run = await storage.createMonthlySalaryRun({
    runKey: getRunKey(target),
    salaryYear: target.year,
    salaryMonth: target.month,
    status: 'running',
    recordCount: 0,
    skippedCount: 0,
    emailTo: config.emailRecipients,
  });

  return { run };
}

async function markRunFailed(run: MonthlySalaryRun | undefined, error: unknown) {
  if (!run) {
    return undefined;
  }

  const message = error instanceof Error ? error.message : String(error);
  return storage.updateMonthlySalaryRun(run.id, {
    status: 'failed',
    errorMessage: message,
    completedAt: new Date(),
  });
}

export async function runMonthlySalaryAutomation(
  options: MonthlySalaryAutomationOptions = {}
): Promise<MonthlySalaryAutomationResult> {
  const config = options.config ?? getSalaryAutomationConfig();
  const target = options.target ?? getPreviousSalaryMonthTarget(options.now, config.timeZone);
  const sendEmail = options.sendEmail ?? true;
  const calculatedRecords: InsertSalaryRecord[] = [];
  const persistedRecords: SalaryRecord[] = [];
  const skippedEmployees: MonthlySalaryAutomationResult['skippedEmployees'] = [];

  const { run, skipReason } = await acquireRun(target, options, config);
  if (skipReason) {
    return {
      target,
      status: 'skipped',
      reason: skipReason,
      run,
      calculatedRecords,
      persistedRecords: await storage.getSalaryRecordsByYearMonth(target.year, target.month),
      skippedEmployees,
      emailRecipients: run?.emailTo ?? [],
    };
  }

  try {
    const settings = await storage.getSettings();
    if (!settings) {
      throw new Error('Salary settings are not configured.');
    }

    const employees = (await storage.getAllEmployees()).filter(isActivePayrollEmployee);
    for (const employee of employees) {
      const existingRecord = await storage.getSalaryRecordByYearMonthEmployee(
        target.year,
        target.month,
        employee.id
      );

      if (existingRecord && !options.force) {
        persistedRecords.push(existingRecord);
        skippedEmployees.push({
          employeeId: employee.id,
          employeeName: employee.name,
          reason: 'salary record already exists',
        });
        continue;
      }

      const attendance = await storage.getTemporaryAttendanceByEmployeeAndMonth(
        employee.id,
        target.year,
        target.month
      );
      const specialLeaveInfo = getSpecialLeaveInfoForMonth(employee, settings, target);
      if (attendance.length === 0 && !specialLeaveInfo) {
        skippedEmployees.push({
          employeeId: employee.id,
          employeeName: employee.name,
          reason: 'no attendance or special leave data for month',
        });
        continue;
      }

      const draft = buildSalaryDraftForEmployee(employee, attendance, settings, target);
      const finalRecord = await buildCalculatedSalaryRecord(draft, settings);
      calculatedRecords.push(finalRecord);

      if (options.dryRun) {
        continue;
      }

      const persistedRecord = existingRecord
        ? await storage.updateSalaryRecord(existingRecord.id, finalRecord)
        : await storage.createSalaryRecord(finalRecord);

      if (persistedRecord) {
        persistedRecords.push(persistedRecord);
      }
    }

    if (options.dryRun) {
      return {
        target,
        status: 'dry-run',
        calculatedRecords,
        persistedRecords: [],
        skippedEmployees,
        emailRecipients: [],
      };
    }

    if (persistedRecords.length === 0) {
      const updatedRun = run
        ? await storage.updateMonthlySalaryRun(run.id, {
            status: 'skipped',
            recordCount: 0,
            skippedCount: skippedEmployees.length,
            errorMessage: 'No salary records were generated.',
            completedAt: new Date(),
          })
        : undefined;

      return {
        target,
        status: 'skipped',
        reason: 'no salary records were generated',
        run: updatedRun ?? run,
        calculatedRecords,
        persistedRecords,
        skippedEmployees,
        emailRecipients: [],
      };
    }

    const pdfPath = await generateMonthlySalaryPdf(target, persistedRecords, config);
    let emailRecipients: string[] = [];

    if (sendEmail) {
      if (!isSalaryEmailConfigured(config)) {
        throw new Error('Salary email is not configured.');
      }

      const emailResult = await sendMonthlySalaryEmail({
        target,
        records: persistedRecords,
        pdfPath,
        config,
      });
      emailRecipients = emailResult.recipients;
    }

    const updatedRun = run
      ? await storage.updateMonthlySalaryRun(run.id, {
          status: 'succeeded',
          recordCount: persistedRecords.length,
          skippedCount: skippedEmployees.length,
          pdfPath,
          emailTo: emailRecipients,
          emailSentAt: sendEmail ? new Date() : null,
          errorMessage: null,
          completedAt: new Date(),
        })
      : undefined;

    log.info('Monthly salary automation completed', {
      target,
      recordCount: persistedRecords.length,
      skippedCount: skippedEmployees.length,
      pdfPath,
      emailRecipients,
    });

    return {
      target,
      status: 'succeeded',
      run: updatedRun ?? run,
      calculatedRecords,
      persistedRecords,
      skippedEmployees,
      pdfPath,
      emailRecipients,
    };
  } catch (error) {
    const failedRun = await markRunFailed(run, error);
    log.error('Monthly salary automation failed', error);

    return {
      target,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      run: failedRun ?? run,
      calculatedRecords,
      persistedRecords,
      skippedEmployees,
      emailRecipients: [],
    };
  }
}
