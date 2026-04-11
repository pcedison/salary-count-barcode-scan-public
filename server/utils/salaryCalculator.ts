/**
 * 伺服器端薪資計算統一模組
 *
 * 這個模組使用共享計算模型確保所有薪資計算在後端使用一致的邏輯，成為單一真實來源
 * 前端只負責顯示計算結果，確保計算一致性
 */

import {
  calculateSalary as sharedCalculateSalary,
  selectCalculationModel,
  registerSpecialRule,
  DailyOvertimeRecord
} from '../../shared/calculationModel';

import {
  calculateGrossSalary as sharedCalculateGrossSalary,
  calculateNetSalary as sharedCalculateNetSalary,
  calculateOvertime as sharedCalculateOvertime,
  calculateOvertimePay as sharedCalculateOvertimePay,
  normalizeSalarySettings
} from '../../shared/utils/salaryMath';

import { createLogger } from './logger';

const log = createLogger('salary-calc');

// 在伺服器端定義所有需要的類型，避免依賴導入問題
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
  grossSalary: number;      // 要使用的總薪資
  netSalary: number;        // 要使用的實領金額
  description?: string;     // 規則描述
}

/**
 * 完整計算模型接口
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

// 特殊規則緩存，從數據庫載入
let specialRulesLoaded = false;

/**
 * 從數據庫加載特殊計算規則
 */
export async function loadSpecialRulesFromDB(db: any): Promise<void> {
  if (specialRulesLoaded) return;

  try {
    const dbRules = await db.query.calculationRules.findMany({
      where: { isActive: true }
    });

    for (const rule of dbRules) {
      registerSpecialRule({
        year: rule.year,
        month: rule.month,
        employeeId: rule.employeeId,
        totalOT1Hours: rule.totalOT1Hours,
        totalOT2Hours: rule.totalOT2Hours,
        baseSalary: rule.baseSalary,
        welfareAllowance: rule.welfareAllowance,
        housingAllowance: rule.housingAllowance,
        totalOvertimePay: rule.totalOvertimePay,
        grossSalary: rule.grossSalary,
        netSalary: rule.netSalary,
        description: rule.description
      });
    }

    specialRulesLoaded = true;
    log.info(`已從資料庫載入 ${dbRules.length} 條薪資規則`);
  } catch (err) {
    log.error('載入薪資規則時出錯:', err);
    // 沒有資料庫規則時，系統會繼續使用標準計算邏輯
    specialRulesLoaded = true;
  }
}

/**
 * 保存特殊規則到數據庫
 */
export async function saveSpecialRuleToDB(db: any, rule: SpecialCaseRule): Promise<void> {
  try {
    // 生成規則識別碼
    const ruleKey = `${rule.year}-${rule.month}-${rule.employeeId || 'all'}`;

    // 檢查規則是否已存在
    const existingRule = await db.query.calculationRules.findFirst({
      where: { ruleKey }
    });

    if (existingRule) {
      // 更新現有規則
      await db.update(db.calculationRules)
        .set({
          totalOT1Hours: rule.totalOT1Hours,
          totalOT2Hours: rule.totalOT2Hours,
          baseSalary: rule.baseSalary,
          welfareAllowance: rule.welfareAllowance,
          housingAllowance: rule.housingAllowance,
          totalOvertimePay: rule.totalOvertimePay,
          grossSalary: rule.grossSalary,
          netSalary: rule.netSalary,
          description: rule.description,
          updatedAt: new Date(),
          isActive: true
        })
        .where({ id: existingRule.id });
    } else {
      // 創建新規則
      await db.insert(db.calculationRules).values({
        ruleKey,
        version: `${rule.year}.${rule.month}.1`,
        year: rule.year,
        month: rule.month,
        employeeId: rule.employeeId,
        totalOT1Hours: rule.totalOT1Hours,
        totalOT2Hours: rule.totalOT2Hours,
        baseSalary: rule.baseSalary,
        welfareAllowance: rule.welfareAllowance,
        housingAllowance: rule.housingAllowance,
        totalOvertimePay: rule.totalOvertimePay,
        grossSalary: rule.grossSalary,
        netSalary: rule.netSalary,
        description: rule.description,
        createdBy: 'system',
        isActive: true
      });
    }

    // 註冊規則到內存中
    // 確保所有必需的屬性都有定義
    const validRule: SpecialCaseRule = {
      ...rule,
      // 確保沒有可選的 grossSalary 和 netSalary
      grossSalary: rule.grossSalary || 0,
      netSalary: rule.netSalary || 0,
      // 確保其他可能缺失的屬性也有默認值
      housingAllowance: rule.housingAllowance || 0
    };
    registerSpecialRule(validRule);

    log.info(`特殊計算規則 ${ruleKey} 已保存到數據庫`);
  } catch (err) {
    log.error('保存特殊計算規則時出錯:', err);
    throw err;
  }
}

/**
 * 標準加班費計算函數 - 使用共用的每日計算方式
 * 每日個別計算並四捨五入後加總，避免月彙總帶來的差異
 */
export function calculateOvertimePay(
  overtimeHours: OvertimeHours,
  settings: CalculationSettings
): number {
  // 使用共享模型中的標準計算邏輯
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
  // 使用共享模型中的標準計算邏輯
  return sharedCalculateGrossSalary(baseSalary, overtimePay, holidayPay, welfareAllowance, housingAllowance);
}

/**
 * 計算淨薪資（實發金額）
 */
export function calculateNetSalary(
  grossSalary: number,
  totalDeductions: number
): number {
  // 使用共享模型中的標準計算邏輯
  return sharedCalculateNetSalary(grossSalary, totalDeductions);
}

/**
 * 根據日考勤記錄轉換為日加班記錄
 */
export function convertAttendanceToDaily(attendanceRecords: any[]): DailyOvertimeRecord[] {
  return attendanceRecords.map(record => {
    // 判斷是否有加班
    if (!record.clockIn || !record.clockOut) return null;

    // 計算加班時數
    const { ot1, ot2 } = calculateOvertime(record.clockIn, record.clockOut);

    // 如果沒有加班，返回null
    if (ot1 === 0 && ot2 === 0) return null;

    return {
      date: record.date,
      ot1Hours: ot1,
      ot2Hours: ot2
    };
  }).filter(record => record !== null) as DailyOvertimeRecord[];
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

/**
 * 統一薪資計算函數 - 整合所有計算步驟，確保一致性
 * 推薦使用下方的 calculateSalaryByDaily 函數，此函數僅為兼容舊代碼保留
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
  // 使用共享計算模型
  return sharedCalculateSalary(
    year,
    month,
    employeeId, // 使用傳入的員工ID
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
 * 新的薪資計算函數 - 每日單獨計算後再加總
 */
export function calculateSalaryByDaily(
  year: number,
  month: number,
  dailyRecords: DailyOvertimeRecord[],
  baseSalary: number,
  totalDeductions: number,
  settings: CalculationSettings,
  holidayPay: number = 0,
  welfareAllowance?: number,
  housingAllowance: number = 0,
  employeeId: number = 0
): SalaryCalculationResult {
  // 選擇適當的計算模型
  const model = selectCalculationModel(year, month);

  // 使用模型配置或提供的配置
  const config = normalizeSalarySettings(settings || model.baseConfiguration);

  // 計算總加班時數，供資料驅動規則比對使用
  const totalOT1Hours = dailyRecords.reduce((total, record) => total + record.ot1Hours, 0);
  const totalOT2Hours = dailyRecords.reduce((total, record) => total + record.ot2Hours, 0);
  const overtimeHours: OvertimeHours = { totalOT1Hours, totalOT2Hours };

  // 檢查是否有適用的特殊情況
  const specialCase = model.checkSpecialCase(
    year, month, employeeId, overtimeHours, baseSalary, welfareAllowance, housingAllowance
  );

  if (specialCase) {
    // 對於特殊情況，使用特定的計算結果
    return {
      totalOT1Hours,
      totalOT2Hours,
      totalOvertimePay: specialCase.totalOvertimePay,
      grossSalary: specialCase.grossSalary,
      netSalary: specialCase.netSalary
    };
  }

  // 標準計算流程
  // 1. 正確計算加班費 - 每日單獨計算後加總
  // 使用標準計算邏輯中的每日計算方法
  let totalOvertimePay = 0;

  // 逐日計算加班費並加總
  for (const record of dailyRecords) {
    const dailyOvertimePay = sharedCalculateOvertimePay(
      {
        totalOT1Hours: record.ot1Hours,
        totalOT2Hours: record.ot2Hours
      },
      config
    );
    totalOvertimePay += dailyOvertimePay;
  }

  // 2. 計算總薪資
  const welfareAmount = welfareAllowance !== undefined ? welfareAllowance : (config.welfareAllowance || 0);
  const grossSalary = sharedCalculateGrossSalary(baseSalary, totalOvertimePay, holidayPay, welfareAmount, housingAllowance);

  // 3. 計算淨薪資
  const netSalary = sharedCalculateNetSalary(grossSalary, totalDeductions);

  return {
    totalOT1Hours,
    totalOT2Hours,
    totalOvertimePay,
    grossSalary,
    netSalary
  };
}

/**
 * 驗證薪資記錄是否符合統一計算標準
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
  settings?: CalculationSettings,
  employeeId: number = 0
): boolean {
  if (!settings) return false;

  // 檢查特殊情況
  const model = selectCalculationModel(year, month);
  const specialCase = model.checkSpecialCase(
    year,
    month,
    employeeId, // 使用傳入的員工ID
    { totalOT1Hours: record.totalOT1Hours, totalOT2Hours: record.totalOT2Hours },
    record.baseSalary, // 使用記錄中的基本薪資
    record.welfareAllowance, // 使用記錄中的福利津貼
    record.housingAllowance // 使用記錄中的住房津貼
  );

  if (specialCase) {
    // 特殊情況下直接比較結果
    return record.totalOvertimePay === specialCase.totalOvertimePay &&
           record.grossSalary === specialCase.grossSalary &&
           record.netSalary === specialCase.netSalary;
  }

  const expectedTotalOTPay = sharedCalculateOvertimePay(
    { totalOT1Hours: record.totalOT1Hours, totalOT2Hours: record.totalOT2Hours },
    normalizeSalarySettings(settings)
  );

  return Math.abs(record.totalOvertimePay - expectedTotalOTPay) <= 1;
}

/**
 * 使用每日計算方法驗證薪資記錄 - 更精確的方法
 */
export function validateSalaryRecordByDaily(
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
  dailyRecords: DailyOvertimeRecord[],
  settings?: CalculationSettings,
  employeeId: number = 0,
  holidayPay: number = 0,
  totalDeductions: number = 0
): boolean {
  if (!settings) return false;

  // 使用每日計算方法計算薪資
  const calculatedResult = calculateSalaryByDaily(
    year,
    month,
    dailyRecords,
    record.baseSalary,
    totalDeductions,
    settings,
    holidayPay,
    record.welfareAllowance,
    record.housingAllowance,
    employeeId
  );

  // 比較計算結果與記錄的差異
  // 加班費、總薪資和實發金額應該都相同（允許少量誤差）
  return Math.abs(calculatedResult.totalOvertimePay - record.totalOvertimePay) <= 1 &&
         Math.abs(calculatedResult.grossSalary - record.grossSalary) <= 1 &&
         Math.abs(calculatedResult.netSalary - record.netSalary) <= 1;
}

/**
 * 計算單一日期的加班時數
 * 根據上下班時間計算標準加班時數
 *
 * OT1 加班時間範圍（16:00-18:10）：
 * 1. 16:10 前，加班 0 小時
 * 2. 16:10 - 16:35，加班 0.5 小時
 * 3. 16:36 - 17:10，加班 1 小時
 * 4. 17:11 - 17:35，加班 1.5 小時
 * 5. 17:36 - 18:10，加班 2 小時
 */

/**
 * 計算單一日期的加班時數
 * 根據上下班時間計算標準加班時數
 */
export function calculateOvertime(clockIn: string, clockOut: string): { ot1: number; ot2: number } {
  const overtime = sharedCalculateOvertime(clockIn, clockOut);
  return { ot1: overtime.ot1, ot2: overtime.ot2 };
}
