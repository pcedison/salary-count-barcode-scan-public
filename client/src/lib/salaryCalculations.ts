/**
 * 前端薪資計算模塊
 *
 * 本模塊使用共享計算模型確保前後端計算邏輯一致
 * 客戶端薪資計算應與服務器端完全一致以保證數據準確性
 */

import { constants } from './constants';

// 從共享模型導入函數
import {
  calculateSalary as sharedCalculateSalary,
  validateSalaryRecord as sharedValidateSalaryRecord
} from '@shared/calculationModel';

import {
  calculateDailyOvertimePay as sharedCalculateDailyOvertimePay,
  calculateOvertime as sharedCalculateOvertime,
  calculateOvertimePay as sharedCalculateOvertimePay,
  calculateGrossSalary as sharedCalculateGrossSalary,
  calculateNetSalary as sharedCalculateNetSalary
} from '@shared/utils/salaryMath';

/**
 * 計算打卡之間的加班時數
 * 根據公司規定：早到從8:00開始記薪，16:00後開始計算加班
 *
 * OT1 加班時間範圍（16:00-18:10）：
 * 1. 16:10 前，加班 0 小時
 * 2. 16:10 - 16:35，加班 0.5 小時
 * 3. 16:36 - 17:10，加班 1 小時
 * 4. 17:11 - 17:35，加班 1.5 小時
 * 5. 17:36 - 18:10，加班 2 小時
 *
 * @param clockIn 上班打卡時間
 * @param clockOut 下班打卡時間
 */
export function calculateOvertime(clockIn: string, clockOut: string): { ot1: number, ot2: number } {
  const overtime = sharedCalculateOvertime(clockIn, clockOut);
  return { ot1: overtime.ot1, ot2: overtime.ot2 };
}

/**
 * 計算單日加班費用
 * @param clockIn 上班打卡時間
 * @param clockOut 下班打卡時間
 * @param baseSalary 基本薪資 (用於計算時薪)
 */
export function calculateDailyOvertimePay(clockIn: string, clockOut: string, baseSalary: number): number {
  const hourlyRate = baseSalary / constants.STANDARD_WORK_DAYS / constants.STANDARD_WORK_HOURS;
  return sharedCalculateDailyOvertimePay(clockIn, clockOut, {
    baseHourlyRate: hourlyRate,
    ot1Multiplier: constants.OT1_MULTIPLIER,
    ot2Multiplier: constants.OT2_MULTIPLIER
  });
}

// 直接在客戶端定義所有需要的類型 (避免導入問題)
/**
 * 加班時數結構
 */
export interface OvertimeHours {
  totalOT1Hours: number;  // 第一階段加班時數 (1.34倍)
  totalOT2Hours: number;  // 第二階段加班時數 (1.67倍)
}

/**
 * 薪資計算結果
 */
export interface SalaryCalculationResult {
  totalOT1Hours: number;    // 最終計算使用的第一階段加班時數
  totalOT2Hours: number;    // 最終計算使用的第二階段加班時數
  totalOvertimePay: number; // 總加班費
  grossSalary: number;      // 毛薪資 (總薪資)
  netSalary: number;        // 淨薪資 (實領金額)
}

/**
 * 計算模型基本配置
 */
export interface CalculationSettings {
  baseHourlyRate: number;   // 基本時薪
  ot1Multiplier: number;    // 第一階段加班倍率
  ot2Multiplier: number;    // 第二階段加班倍率
  baseMonthSalary: number;  // 基本月薪
  welfareAllowance?: number; // 福利津貼
}

/**
 * 特殊規則條件
 */
export interface SpecialCaseCondition {
  year: number;             // 適用年份
  month: number;            // 適用月份
  employeeId?: number;      // 適用員工ID (可選)
  totalOT1Hours: number;    // 匹配的第一階段加班時數
  totalOT2Hours: number;    // 匹配的第二階段加班時數
  baseSalary: number;       // 匹配的基本薪資
  welfareAllowance?: number; // 匹配的福利津貼 (可選)
  housingAllowance?: number; // 匹配的住房津貼 (可選)
}

/**
 * 特殊規則配置
 */
export interface SpecialCaseRule extends SpecialCaseCondition {
  totalOvertimePay: number; // 要使用的總加班費
  grossSalary?: number;     // 要使用的總薪資 (可選)
  netSalary?: number;       // 要使用的實領金額 (可選)
}

/**
 * 完整計算模型
 */
export interface CalculationModel {
  baseConfiguration: CalculationSettings;
  calculateOvertimePay: (overtimeHours: OvertimeHours, settings: CalculationSettings) => number;
  calculateGrossSalary: (baseSalary: number, overtimePay: number, holidayPay: number, welfareAllowance: number, housingAllowance: number) => number;
  calculateNetSalary: (grossSalary: number, totalDeductions: number) => number;
  checkSpecialCase: (year: number, month: number, employeeId: number, overtimeHours: OvertimeHours, baseSalary: number, welfareAllowance?: number, housingAllowance?: number) => any;
  version: string;
  description: string;
}

/**
 * 標準加班費計算函數 - 使用會計部門的標準計算方式
 * 會計部門的方法：每日個別計算並四捨五入後加總
 */
export function calculateOvertimePay(
  overtimeHours: OvertimeHours,
  settings: CalculationSettings
): number {
  // 委託給共享計算模型
  return sharedCalculateOvertimePay(overtimeHours, settings);
}

/**
 * 計算總薪資（毛薪資）
 */
export function calculateGrossSalary(
  baseSalary: number,
  overtimePay: number,
  holidayPay: number = 0,
  welfareAllowance: number = 0,
  housingAllowance: number = 0
): number {
  return sharedCalculateGrossSalary(baseSalary, overtimePay, holidayPay, welfareAllowance, housingAllowance);
}

/**
 * 計算淨薪資（實發金額）
 */
export function calculateNetSalary(
  grossSalary: number,
  totalDeductions: number
): number {
  return sharedCalculateNetSalary(grossSalary, totalDeductions);
}

/**
 * 統一薪資計算函數
 * 整合所有計算步驟，確保一致性
 */
export function calculateSalary(
  year: number,
  month: number,
  rawOvertimeHours: OvertimeHours,
  baseSalary: number,
  totalDeductions: number,
  settings: CalculationSettings,
  holidayPay: number = 0,
  welfareAllowance?: number,
  housingAllowance: number = 0,
  employeeId: number = 0
): SalaryCalculationResult {
  // 委託給共享計算模型
  return sharedCalculateSalary(
    year,
    month,
    employeeId,
    rawOvertimeHours,
    baseSalary,
    totalDeductions,
    settings,
    holidayPay,
    welfareAllowance,
    housingAllowance
  );
}

/**
 * 驗證薪資記錄是否符合統一計算標準
 * 使用單一標準方法驗證所有月份的薪資記錄
 * 不再區分特殊月份，確保系統計算邏輯的一致性
 */
export function validateSalaryRecord(
  year: number,
  month: number,
  record: {
    totalOT1Hours: number;
    totalOT2Hours: number;
    totalOvertimePay: number;
    grossSalary: number;
    netSalary: number;
    baseSalary: number;
    welfareAllowance?: number;
    housingAllowance?: number;
  },
  totalDeductions: number,
  settings?: CalculationSettings,
  employeeId: number = 0
): boolean {
  // 委託給共享的驗證函數
  return sharedValidateSalaryRecord(
    year,
    month,
    employeeId,
    record,
    totalDeductions,
    settings
  );
}

/**
 * 此簡化版本用於支持舊有代碼兼容，新代碼應使用上面的標準實現
 */
export function calculateSimpleOvertime(clockIn: string, clockOut: string): { ot1: number; ot2: number } {
  return calculateOvertime(clockIn, clockOut);
}
