import { afterEach, describe, expect, it } from 'vitest';

import { encrypt as encryptAes } from '@shared/utils/encryption';

import {
  buildScanSuccessResult,
  filterAttendanceByDate,
  getLatestAttendanceRecord,
  getLatestIncompleteAttendanceRecord,
  matchEmployeeByScanId
} from './scan-helpers';

const TEST_ENCRYPTION_KEY = '12345678901234567890123456789012';

describe('scan route helpers', () => {
  const employee = {
    id: 7,
    name: '測試員工',
    idNumber: 'A123456789',
    isEncrypted: false,
    department: '生產部',
    position: null,
    email: null,
    phone: null,
    active: true,
    specialLeaveDays: 0,
    specialLeaveWorkDateRange: null,
    specialLeaveUsedDates: [],
    specialLeaveCashDays: 0,
    specialLeaveCashMonth: null,
    specialLeaveNotes: null,
    createdAt: new Date('2026-03-12T00:00:00.000Z')
  };

  afterEach(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  it('matches a plain scanned id against a plain employee', () => {
    expect(matchEmployeeByScanId([employee], employee.idNumber)).toEqual(employee);
  });

  it('matches plaintext scan tokens against AES-encrypted employee data', () => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const aesEmployee = {
      ...employee,
      idNumber: encryptAes(employee.idNumber),
      isEncrypted: true
    };

    expect(matchEmployeeByScanId([aesEmployee], employee.idNumber)).toEqual(aesEmployee);
  });

  it('filters mixed date formats and returns the latest event by clock-out time', () => {
    const records = [
      {
        id: 1,
        employeeId: 7,
        date: '2026-03-12',
        clockIn: '08:00',
        clockOut: '17:00',
        isHoliday: false,
        isBarcodeScanned: true,
        holidayId: null,
        holidayType: null,
        createdAt: new Date('2026-03-12T08:00:00.000Z')
      },
      {
        id: 2,
        employeeId: 8,
        date: '2026/03/12',
        clockIn: '09:00',
        clockOut: '',
        isHoliday: false,
        isBarcodeScanned: true,
        holidayId: null,
        holidayType: null,
        createdAt: new Date('2026-03-12T09:00:00.000Z')
      }
    ];

    const todayRecords = filterAttendanceByDate(records, '2026/03/12');

    expect(todayRecords).toHaveLength(2);
    expect(getLatestAttendanceRecord(todayRecords)).toEqual(records[0]);
  });

  it('selects the latest incomplete record for clock-out updates', () => {
    const records = [
      {
        id: 1,
        employeeId: 7,
        date: '2026/03/12',
        clockIn: '08:00',
        clockOut: '',
        isHoliday: false,
        isBarcodeScanned: true,
        holidayId: null,
        holidayType: null,
        createdAt: new Date('2026-03-12T08:00:00.000Z')
      },
      {
        id: 2,
        employeeId: 7,
        date: '2026/03/12',
        clockIn: '13:00',
        clockOut: '',
        isHoliday: false,
        isBarcodeScanned: true,
        holidayId: null,
        holidayType: null,
        createdAt: new Date('2026-03-12T13:00:00.000Z')
      }
    ];

    expect(getLatestIncompleteAttendanceRecord(records)).toEqual(records[1]);
  });

  it('builds a compatible clock-out payload for barcode scan responses', () => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const result = buildScanSuccessResult(
      {
        ...employee,
        idNumber: encryptAes(employee.idNumber),
        isEncrypted: true
      },
      {
        id: 5,
        employeeId: 7,
        date: '2026/03/12',
        clockIn: '08:00',
        clockOut: '17:00',
        isHoliday: false,
        isBarcodeScanned: true,
        holidayId: null,
        holidayType: null,
        createdAt: new Date('2026-03-12T08:00:00.000Z')
      },
      '2026-03-12T09:00:00.000Z'
    );

    expect(result.action).toBe('clock-out');
    expect(result.isClockIn).toBe(false);
    expect(result.clockTime).toBe('17:00');
    expect(result.message).toContain('下班');
    expect(result.idNumber).toBe(employee.idNumber);
    expect(result.employee.idNumber).toBe(employee.idNumber);
  });
});
