import { describe, expect, it } from 'vitest';

import type { SalaryRecord } from '@shared/schema';

import {
  buildMonthlySalaryPrintUrl,
  resolveSalaryPrintBaseUrl,
} from './salaryPdf';

function salaryRecord(id: number): SalaryRecord {
  return {
    id,
    salaryYear: 2026,
    salaryMonth: 4,
    employeeId: id,
    employeeName: `Employee ${id}`,
    baseSalary: 30000,
    housingAllowance: 0,
    welfareAllowance: 500,
    allowances: [],
    totalOT1Hours: 2,
    totalOT2Hours: 1,
    totalOvertimePay: 700,
    holidayDays: 0,
    holidayDailySalary: 1000,
    totalHolidayPay: 0,
    grossSalary: 31200,
    deductions: [],
    totalDeductions: 100,
    netSalary: 31100,
    attendanceData: [],
    specialLeaveInfo: null,
    anonymizedAt: null,
    retentionUntil: null,
    employeeSnapshot: null,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
  };
}

describe('salary PDF print URL builder', () => {
  it('points PDF generation at the existing monthly print page', () => {
    const url = buildMonthlySalaryPrintUrl(
      'https://salary.example.com/',
      [salaryRecord(11), salaryRecord(12)],
      'signed-token'
    );

    expect(url).toBe(
      'https://salary.example.com/print-monthly-salary?ids=11%2C12&token=signed-token&automation=1'
    );
  });

  it('falls back to the local app server when no public base URL is configured', () => {
    expect(
      resolveSalaryPrintBaseUrl({
        enabled: true,
        timeZone: 'Asia/Taipei',
        runHour: 1,
        runMinute: 15,
        intervalMs: 3600000,
        emailRecipients: [],
        smtpPort: 587,
        smtpSecure: false,
      })
    ).toBe(`http://127.0.0.1:${process.env.PORT || '5000'}`);
  });
});
