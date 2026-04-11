import { normalizeDateToSlash } from '@shared/utils/specialLeaveSync';

import type { Employee, TemporaryAttendance } from '@shared/schema';
import {
  getEmployeeDisplayId,
  matchesEmployeeIdentity,
  normalizeEmployeeIdentity
} from '../utils/employeeIdentity';

const TAIWAN_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface TaiwanDateTimeParts {
  dateKey: string;
  time: string;
  timestamp: string;
}

export interface ScanSuccessResult {
  employeeId: number;
  employeeName: string;
  department: string;
  idNumber: string;
  action: 'clock-in' | 'clock-out';
  isClockIn: boolean;
  attendance: TemporaryAttendance;
  success: true;
  timestamp: string;
  message: string;
  statusMessage: string;
  clockTime: string;
  time: string;
  employee: {
    id: number;
    name: string;
    department: string;
    idNumber: string;
  };
}

export function getTaiwanDateTimeParts(now: Date = new Date()): TaiwanDateTimeParts {
  const taiwanTime = new Date(now.getTime() + TAIWAN_TIME_OFFSET_MS);
  const dateKey = [
    taiwanTime.getUTCFullYear(),
    String(taiwanTime.getUTCMonth() + 1).padStart(2, '0'),
    String(taiwanTime.getUTCDate()).padStart(2, '0')
  ].join('/');
  const time = [
    String(taiwanTime.getUTCHours()).padStart(2, '0'),
    String(taiwanTime.getUTCMinutes()).padStart(2, '0')
  ].join(':');

  return {
    dateKey,
    time,
    timestamp: now.toISOString()
  };
}

export function normalizeScanId(idNumber: string): string {
  return normalizeEmployeeIdentity(idNumber);
}

export function buildEmployeeCacheKey(idNumber: string): string {
  return normalizeScanId(idNumber).replace(/[^A-Z0-9]/g, '_');
}

export function matchEmployeeByScanId(
  employees: Employee[],
  rawIdNumber: string
): Employee | undefined {
  const normalizedIdNumber = normalizeScanId(rawIdNumber);

  for (const employee of employees) {
    if (matchesEmployeeIdentity(employee, normalizedIdNumber)) {
      return employee;
    }
  }

  return undefined;
}

export function filterAttendanceByDate(
  records: TemporaryAttendance[],
  dateKey: string
): TemporaryAttendance[] {
  const normalizedDateKey = normalizeDateToSlash(dateKey);
  return records.filter(record => normalizeDateToSlash(record.date) === normalizedDateKey);
}

export function getAttendanceEventTime(record: TemporaryAttendance): string {
  const clockOut = record.clockOut?.trim();
  return clockOut ? clockOut : record.clockIn;
}

function parseTimeToMinutes(time: string): number {
  const [hours = '0', minutes = '0'] = time.split(':');
  const parsedHours = Number.parseInt(hours, 10);
  const parsedMinutes = Number.parseInt(minutes, 10);

  if (Number.isNaN(parsedHours) || Number.isNaN(parsedMinutes)) {
    return -1;
  }

  return parsedHours * 60 + parsedMinutes;
}

export function compareAttendanceByLatestEvent(
  left: TemporaryAttendance,
  right: TemporaryAttendance
): number {
  const eventDifference =
    parseTimeToMinutes(getAttendanceEventTime(right)) -
    parseTimeToMinutes(getAttendanceEventTime(left));

  if (eventDifference !== 0) {
    return eventDifference;
  }

  const createdAtDifference =
    new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime();

  if (createdAtDifference !== 0) {
    return createdAtDifference;
  }

  return (right.id ?? 0) - (left.id ?? 0);
}

export function getLatestAttendanceRecord(
  records: TemporaryAttendance[]
): TemporaryAttendance | undefined {
  return [...records].sort(compareAttendanceByLatestEvent)[0];
}

export function getLatestIncompleteAttendanceRecord(
  records: TemporaryAttendance[]
): TemporaryAttendance | undefined {
  return getLatestAttendanceRecord(
    records.filter(record => !record.clockOut || record.clockOut.trim() === '')
  );
}

export function buildScanSuccessResult(
  employee: Employee,
  attendance: TemporaryAttendance,
  timestamp: string
): ScanSuccessResult {
  const isClockIn = !attendance.clockOut || attendance.clockOut.trim() === '';
  const action = isClockIn ? 'clock-in' : 'clock-out';
  const actionText = isClockIn ? '上班' : '下班';
  const department = employee.department || '生產部';
  const clockTime = isClockIn ? attendance.clockIn : attendance.clockOut || attendance.clockIn;
  const message = `${employee.name} ${actionText}打卡成功`;
  const displayId = getEmployeeDisplayId(employee);

  return {
    employeeId: employee.id,
    employeeName: employee.name,
    department,
    idNumber: displayId,
    action,
    isClockIn,
    attendance,
    success: true,
    timestamp,
    message,
    statusMessage: message,
    clockTime,
    time: clockTime,
    employee: {
      id: employee.id,
      name: employee.name,
      department,
      idNumber: displayId
    }
  };
}
