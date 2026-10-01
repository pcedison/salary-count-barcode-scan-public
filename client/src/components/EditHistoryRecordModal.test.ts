import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import EditHistoryRecordModal from './EditHistoryRecordModal';
import type { SalaryRecord } from '@/hooks/useHistoryData';
describe('historical financial editor legacy snapshots', () => {
  it('opens an identified legacy salary record without an attendance snapshot', () => {
    const record: SalaryRecord = { id: 101, revision: 0, employeeId: 7, employeeName: 'Synthetic Employee', salaryYear: 2026, salaryMonth: 9, baseSalary: 30000, grossSalary: 30000, netSalary: 29000, totalOT1Hours: 0, totalOT2Hours: 0, totalOvertimePay: 0, holidayDays: 0, totalHolidayPay: 0, totalDeductions: 1000, deductions: [{ name: 'Synthetic Deduction', amount: 1000 }], attendanceData: null };
    expect(() => renderToString(createElement(EditHistoryRecordModal, { record, isOpen: true, isSaving: false, onClose: () => {}, onSave: async () => {} }))).not.toThrow();
  });
});
