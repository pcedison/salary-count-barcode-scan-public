import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PrintableSalarySheet from './PrintableSalarySheet';
import { toPrintableSalarySnapshot } from '@/lib/printSalary';
import type { ExportSalaryRecord } from '@/lib/historyExport';

const record: ExportSalaryRecord = {
  id: 101, revision: 2, employeeId: 7, employeeName: 'Synthetic Employee',
  salaryYear: 2026, salaryMonth: 9, baseSalary: 30000, grossSalary: 30000,
  netSalary: 29000, deductions: [{ name: 'Synthetic Deduction', amount: 1000 }], totalDeductions: 1000,
  totalOT1Hours: 0, totalOT2Hours: 0, totalOvertimePay: 0, holidayDays: 0, totalHolidayPay: 0,
  attendanceData: [
    { date: '2026-09-02', clockIn: '08:00', clockOut: '17:00', isHoliday: false },
    { date: '2026-09-25', clockIn: '--:--', clockOut: '--:--', isHoliday: true, holidayType: 'national_holiday' },
    { date: '2026-09-28', clockIn: '--:--', clockOut: '--:--', isHoliday: true, holidayType: 'national_holiday' },
  ],
};
const render = (input: ExportSalaryRecord = record) => renderToStaticMarkup(createElement(PrintableSalarySheet, { result: toPrintableSalarySnapshot(input) }));
const summary = (html: string) => html.match(/<tr class="summary-row">([\s\S]*?)<\/tr>/)?.[1] ?? '';

describe('archived salary print snapshot', () => {
  it('identifies employee, salary period, record and revision on every sheet', () => {
    const html = render();
    const repeatedHeader = html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? '';
    for (const text of ['Synthetic Employee', '員工 ID 7', '紀錄 ID 101', '修訂 2', '2026年9月', '上班時間']) expect(repeatedHeader).toContain(text);
  });
  it('uses stored zero overtime even if current clock-based calculations would produce overtime', () => {
    const html = render();
    expect(summary(html)).toContain('>0.0</td>');
    expect(summary(html)).toContain('>0</td>');
    expect(html).not.toContain('>168</td>');
    expect(html.match(/>—<\/td>/g)).toHaveLength(9);
    expect(html).toContain('加班及薪資合計採用此修訂的結算快照');
  });
  it('uses nonzero stored overtime aggregates rather than recomputing daily totals', () => {
    const html = render({ ...record, totalOT1Hours: 12.5, totalOT2Hours: 3.5, totalOvertimePay: 3210, grossSalary: 33210, netSalary: 32210 });
    for (const amount of ['12.5', '3.5', '3210']) expect(summary(html)).toContain('>' + amount + '</td>');
    expect(html).toContain('>33210</td>');
    expect(html).toContain('Synthetic Deduction');
    expect(html).toContain('>-1000</td>');
    expect(html).not.toContain('扣款合計');
    expect(html).toContain('>32210</td>');
  });
  it('prints newly corrected no-clock holidays and handles missing legacy attendance safely', () => {
    const html = render();
    expect(html).toContain('2026-09-25');
    expect(html).toContain('2026-09-28');
    expect(html.match(/國定假日/g)).toHaveLength(2);
    expect(() => render({ ...record, attendanceData: null })).not.toThrow();
  });
  it('escapes employee identity through React instead of injecting raw HTML', () => {
    const html = render({ ...record, employeeName: '<script>synthetic()</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it.each([
    { welfareAllowance: 1200, detail: 700, expected: '+500' },
    { welfareAllowance: 1200, detail: 1700, expected: '-500' },
    { welfareAllowance: 0, detail: 700, expected: '-700' },
  ])('reconciles incomplete historical welfare detail to the stored total: $expected', ({ welfareAllowance, detail, expected }) => {
    const input = { ...record, welfareAllowance, allowances: [{ name: 'Saved allowance detail', amount: detail }], grossSalary: 30000 + welfareAllowance, netSalary: 29000 + welfareAllowance };
    const before = JSON.stringify(input);
    const html = render(input);
    const difference = html.match(/<tr class="summary-size-row welfare-reconciliation-row">([\s\S]*?)<\/tr>/)?.[1] ?? '';
    expect(difference).toContain('歷史津貼明細差異');
    expect(difference).toContain('>' + expected + '</td>');
    expect(html).not.toContain('福利津貼合計（結算快照）');
    expect(html).toContain('>' + input.grossSalary + '</td>');
    expect(html).toContain('>' + input.netSalary + '</td>');
    expect(JSON.stringify(input)).toBe(before);
  });
  it('shows saved full and absent welfare detail without inventing a difference', () => {
    const complete = render({ ...record, welfareAllowance: 1200, allowances: [{ name: 'Full detail', amount: 1200 }] });
    const absent = render({ ...record, welfareAllowance: 1200, allowances: [] });
    const unknown = render({ ...record, welfareAllowance: null, allowances: [{ name: 'Legacy detail', amount: 700 }] });
    for (const html of [complete, absent, unknown]) expect(html).not.toContain('<tr class="summary-size-row welfare-reconciliation-row">');
    expect(complete).not.toContain('福利津貼合計（結算快照）');
    expect(complete).toContain('Full detail');
    expect(absent).toContain('福利津貼：');
    expect(absent).toContain('>1200</td>');
    expect(unknown).toContain('>700</td>');
    expect(unknown).not.toContain('福利津貼合計（結算快照）');
  });
  it('preserves the existing calculation behavior for an unarchived salary result', () => {
    const result = { ...toPrintableSalarySnapshot(record), archived: false };
    const html = renderToStaticMarkup(createElement(PrintableSalarySheet, { result }));
    expect(summary(html)).toContain('>1.0</td>');
    expect(summary(html)).toContain('>168</td>');
    expect(html).not.toContain('每日加班時數與金額未保存原始計算規則');
  });
});
