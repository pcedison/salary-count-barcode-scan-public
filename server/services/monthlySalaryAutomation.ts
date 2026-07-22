import type {
  Employee,
  InsertSalaryRecord,
  MonthlySalaryRun,
  SalaryRecord,
  Settings,
  TemporaryAttendance,
} from '@shared/schema';
import { calculateDailyOvertimeSummary } from '@shared/utils/salaryMath';
import { matchesYearMonth } from '@shared/utils/specialLeaveSync';

import {
  getSalaryAutomationConfig,
  isSalaryEmailConfigured,
  type SalaryAutomationConfig,
} from '../config/salaryAutomation';
import { storage } from '../storage';
import { monthlySalaryRunRepository } from '../repositories/monthlySalaryRunRepository';
import { salaryRepository, type SalaryRecordWrite } from '../repositories/salaryRepository';
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
  const isCashMonth = matchesYearMonth(cashMonth, target.year, target.month);
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
    cashMonth: isCashMonth && cashDays > 0 ? cashMonth : undefined,
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

async function markRunFailed(run: MonthlySalaryRun | undefined, error: unknown) {
  if (!run) {
    return undefined;
  }

  const message = error instanceof Error ? error.message : String(error);
  return monthlySalaryRunRepository.updateMonthlySalaryRun(run.id, {
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

  let run: MonthlySalaryRun | undefined;

  try {
    if (!options.dryRun) {
      const acquireResult = await monthlySalaryRunRepository.acquireRun({
        year: target.year,
        month: target.month,
        runKey: getRunKey(target),
        force: !!options.force,
        emailRecipients: config.emailRecipients,
      });
      run = acquireResult.run;

      if (acquireResult.skipReason) {
        return {
          target,
          status: 'skipped',
          reason: acquireResult.skipReason,
          run,
          calculatedRecords,
          persistedRecords: await salaryRepository.getSalaryRecordsByYearMonth(target.year, target.month),
          skippedEmployees,
          emailRecipients: run?.emailTo ?? [],
        };
      }
    }

    const settings = await storage.getSettings();
    if (!settings) {
      throw new Error('Salary settings are not configured.');
    }

    // 整月資料一次預載(固定 3 次查詢,與員工數無關),避免每員工 N+1 round-trip
    const employees = (await storage.getAllEmployees()).filter(isActivePayrollEmployee);
    const existingRecordsByEmployee = new Map<number, SalaryRecord>();
    for (const record of await salaryRepository.getSalaryRecordsByYearMonth(target.year, target.month)) {
      if (record.employeeId != null) {
        existingRecordsByEmployee.set(record.employeeId, record);
      }
    }
    const attendanceByEmployee = new Map<number, TemporaryAttendance[]>();
    for (const record of await storage.getTemporaryAttendanceByMonth(target.year, target.month)) {
      if (record.employeeId == null) {
        continue;
      }
      const list = attendanceByEmployee.get(record.employeeId);
      if (list) {
        list.push(record);
      } else {
        attendanceByEmployee.set(record.employeeId, [record]);
      }
    }

    // 迴圈只做純計算,寫入意圖先收集、迴圈後一次原子批次寫入
    const pendingWrites: SalaryRecordWrite[] = [];

    for (const employee of employees) {
      const existingRecord = existingRecordsByEmployee.get(employee.id);

      if (existingRecord && !options.force) {
        persistedRecords.push(existingRecord);
        skippedEmployees.push({
          employeeId: employee.id,
          employeeName: employee.name,
          reason: 'salary record already exists',
        });
        continue;
      }

      const attendance = attendanceByEmployee.get(employee.id) ?? [];
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

      pendingWrites.push({ existingId: existingRecord?.id, record: finalRecord });
    }

    if (pendingWrites.length > 0) {
      // 單一 transaction:任何一筆失敗即全部回滾,不留半套月薪資料
      persistedRecords.push(...(await salaryRepository.saveSalaryRecordsAtomically(pendingWrites)));
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
        ? await monthlySalaryRunRepository.updateMonthlySalaryRun(run.id, {
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
      ? await monthlySalaryRunRepository.updateMonthlySalaryRun(run.id, {
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
