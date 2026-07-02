/**
 * 伺服器端薪資計算模組
 *
 * 純委派層：所有共用薪資數學都在 shared/utils/salaryMath.ts 與
 * shared/calculationModel.ts，此檔只保留 salary.routes.ts 實際使用的
 * 介面，加上伺服器獨有的假日薪資調整邏輯（台灣勞基法）。
 */

import { calculateSalary as sharedCalculateSalary } from '../../shared/calculationModel';
import { calculateOvertimePay as sharedCalculateOvertimePay } from '../../shared/utils/salaryMath';

import type {
  CalculationSettings,
  OvertimeHours,
  SalaryCalculationResult,
} from '../../shared/calculationModel';

export type {
  CalculationSettings,
  OvertimeHours,
  SalaryCalculationResult,
} from '../../shared/calculationModel';

/**
 * 標準加班費計算函數 - 委派給共享實作
 */
export function calculateOvertimePay(
  overtimeHours: OvertimeHours,
  settings: CalculationSettings
): number {
  return sharedCalculateOvertimePay(overtimeHours, settings);
}

/**
 * 統一薪資計算函數 - 委派給共享計算模型
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
 * 計算假日類型對薪資的影響（依照台灣勞基法規定）
 * 支援整天假和半天假的計算
 * @param attendanceRecords - 考勤記錄數組（包含 holidayType 和打卡時間）
 * @param baseMonthlySalary - 基本月薪
 * @param standardWorkHours - 標準工作時數（默認為8小時）
 * @param daysPerMonth - 每月計算天數（默認為30天，符合台灣勞基法）
 * @returns 假日薪資調整對象，包含扣款和加班費
 */
export function calculateHolidayPayAdjustments(
  attendanceRecords: Array<{
    date: string;
    holidayType?: string | null;
    clockIn?: string;
    clockOut?: string;
    employeeId?: number
  }>,
  baseMonthlySalary: number,
  standardWorkHours: number = 8,
  daysPerMonth: number = 30
): {
  sickLeaveDeduction: number;
  personalLeaveDeduction: number;
  typhoonLeaveDeduction: number;
  workedHolidayPay: number;
  sickLeaveDays: number;
  personalLeaveDays: number;
  typhoonLeaveDays: number;
  workedHolidayDays: number;
  deductionItems: Array<{ name: string; amount: number; description?: string }>;
  bonusItems: Array<{ name: string; amount: number; description?: string }>;
} {
  // 計算日薪和時薪（依照台灣勞基法：月薪 / 30）
  const dailyWage = baseMonthlySalary / daysPerMonth;
  const hourlyWage = dailyWage / standardWorkHours;

  // 計算實際工作時數的輔助函數
  const calculateActualWorkHours = (clockIn: string, clockOut: string): number => {
    if (!clockIn || !clockOut || clockIn === '--:--' || clockOut === '--:--') return 0;

    const [inH, inM] = clockIn.split(':').map(Number);
    const [outH, outM] = clockOut.split(':').map(Number);

    let inMinutes = inH * 60 + inM;
    const WORK_START = 8 * 60; // 8:00 = 480 分鐘

    // 早到處理：如果早於 8:00 上班，從 8:00 開始計算
    if (inMinutes < WORK_START) {
      inMinutes = WORK_START;
    }

    const outMinutes = outH * 60 + outM;
    const totalMinutes = outMinutes - inMinutes;

    // 返回實際工作小時數（保留小數）
    return Math.max(0, totalMinutes / 60);
  };

  // 初始化計數器和扣款
  let sickLeaveDeduction = 0;
  let personalLeaveDeduction = 0;
  let typhoonLeaveDeduction = 0;
  let workedHolidayPay = 0;
  let sickLeaveDays = 0;
  let personalLeaveDays = 0;
  let typhoonLeaveDays = 0;
  let workedHolidayDays = 0;

  const deductionItems: Array<{ name: string; amount: number; description?: string }> = [];
  const bonusItems: Array<{ name: string; amount: number; description?: string }> = [];

  // 遍歷每筆考勤記錄
  for (const record of attendanceRecords) {
    if (!record.holidayType) continue;

    const actualHours = calculateActualWorkHours(record.clockIn || '', record.clockOut || '');
    const missedHours = Math.max(0, standardWorkHours - actualHours);
    const isFullDay = actualHours === 0 || record.clockIn === '--:--';

    switch (record.holidayType) {
      case 'sick_leave':
        sickLeaveDays += isFullDay ? 1 : (missedHours / standardWorkHours);
        // 病假：扣除未工作時數的 50% 薪資
        const sickDeduction = isFullDay
          ? Math.round(dailyWage * 0.5)
          : Math.round(missedHours * hourlyWage * 0.5);
        sickLeaveDeduction += sickDeduction;

        if (sickDeduction > 0) {
          deductionItems.push({
            name: isFullDay ? `病假扣款 (${record.date})` : `病假扣款 (${record.date}, ${missedHours.toFixed(1)}小時)`,
            amount: sickDeduction,
            description: isFullDay ? '整天病假，扣除日薪50%' : `缺勤${missedHours.toFixed(1)}小時，扣除時薪50%`
          });
        }
        break;

      case 'personal_leave':
        personalLeaveDays += isFullDay ? 1 : (missedHours / standardWorkHours);
        // 事假：扣除未工作時數的 100% 薪資
        const personalDeduction = isFullDay
          ? Math.round(dailyWage)
          : Math.round(missedHours * hourlyWage);
        personalLeaveDeduction += personalDeduction;

        if (personalDeduction > 0) {
          deductionItems.push({
            name: isFullDay ? `事假扣款 (${record.date})` : `事假扣款 (${record.date}, ${missedHours.toFixed(1)}小時)`,
            amount: personalDeduction,
            description: isFullDay ? '整天事假，扣除日薪100%' : `缺勤${missedHours.toFixed(1)}小時，扣除時薪100%`
          });
        }
        break;

      case 'typhoon_leave':
        typhoonLeaveDays += 1;
        // 颱風假：未出勤時扣除當日全額薪資
        const typhoonDeduction = Math.round(dailyWage);
        typhoonLeaveDeduction += typhoonDeduction;

        if (typhoonDeduction > 0) {
          deductionItems.push({
            name: `颱風假扣款 (${record.date})`,
            amount: typhoonDeduction,
            description: '颱風假未出勤，扣除日薪100%'
          });
        }
        break;

      case 'temporary_stop_work_and_classes':
        const temporaryClosureDeduction = Math.round(dailyWage);

        if (temporaryClosureDeduction > 0) {
          deductionItems.push({
            name: `臨時停止上班上課扣款 (${record.date})`,
            amount: temporaryClosureDeduction,
            description: '臨時停止上班上課未出勤，扣除日薪100%'
          });
        }
        break;

      case 'national_holiday':
        // 國定假日：不扣薪，已包含在基本薪資中
        break;

      case 'worked':
        workedHolidayDays += 1;
        // 假日出勤：加發日薪（已包含在加班費計算中，這裡只做記錄）
        const holidayBonus = Math.round(dailyWage);
        workedHolidayPay += holidayBonus;

        bonusItems.push({
          name: `假日出勤加給 (${record.date})`,
          amount: holidayBonus,
          description: '假日出勤，加發日薪'
        });
        break;
    }
  }

  return {
    sickLeaveDeduction,
    personalLeaveDeduction,
    typhoonLeaveDeduction,
    workedHolidayPay,
    sickLeaveDays,
    personalLeaveDays,
    typhoonLeaveDays,
    workedHolidayDays,
    deductionItems,
    bonusItems
  };
}
