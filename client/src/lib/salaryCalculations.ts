/**
 * 前端薪資計算模塊
 *
 * 純委派層：所有共用薪資數學都在 shared/utils/salaryMath.ts。
 * 此檔只保留前端頁面實際使用的兩個便利包裝。
 */

import { constants } from './constants';

import {
  calculateDailyOvertimePay as sharedCalculateDailyOvertimePay,
  calculateOvertime as sharedCalculateOvertime,
} from '@shared/utils/salaryMath';

/**
 * 計算打卡之間的加班時數（回傳 { ot1, ot2 }，捨棄總工時欄位）
 */
export function calculateOvertime(clockIn: string, clockOut: string): { ot1: number; ot2: number } {
  const overtime = sharedCalculateOvertime(clockIn, clockOut);
  return { ot1: overtime.ot1, ot2: overtime.ot2 };
}

/**
 * 計算單日加班費用 — 由基本月薪推導時薪後委派共享實作
 */
export function calculateDailyOvertimePay(clockIn: string, clockOut: string, baseSalary: number): number {
  const hourlyRate = baseSalary / constants.STANDARD_WORK_DAYS / constants.STANDARD_WORK_HOURS;
  return sharedCalculateDailyOvertimePay(clockIn, clockOut, {
    baseHourlyRate: hourlyRate,
    ot1Multiplier: constants.OT1_MULTIPLIER,
    ot2Multiplier: constants.OT2_MULTIPLIER,
  });
}
