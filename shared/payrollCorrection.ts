import { z } from 'zod';
import type { SalaryRecord } from './schema';

export const payrollHolidayTypes = [
  'worked', 'sick_leave', 'personal_leave', 'national_holiday', 'typhoon_leave', 'temporary_stop_work_and_classes', 'special_leave',
] as const;

export const payrollCorrectionRequestSchema = z.object({
  holidays: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    holidayType: z.enum(payrollHolidayTypes),
    name: z.string().trim().min(1).max(100),
    mode: z.enum(['add', 'replace']),
  }).strict()).min(1).max(31),
  reason: z.string().trim().min(1).max(1000),
  paymentHandling: z.enum(['unpaid', 'paid_adjustment', 'unknown_adjustment']),
}).strict();

export type PayrollHolidayType = typeof payrollHolidayTypes[number];
export type PayrollCorrectionHoliday = z.infer<typeof payrollCorrectionRequestSchema>['holidays'][number];
export type PayrollCorrectionRequest = z.infer<typeof payrollCorrectionRequestSchema>;

export interface PayrollCorrectionDelta {
  grossSalary: number;
  totalDeductions: number;
  netSalary: number;
  totalHolidayPay: number;
  holidayDays: number;
}

export interface PayrollCorrectionPreview {
  recordId: number;
  revision: number;
  before: SalaryRecord;
  after: SalaryRecord;
  delta: PayrollCorrectionDelta;
  holidays: PayrollCorrectionHoliday[];
  reason: string;
  paymentHandling: PayrollCorrectionRequest['paymentHandling'];
  calculationNote: string;
}
