/**
 * 薪資計算模型 (共享模塊)
 *
 * 此模塊提供前後端統一的計算模型和邏輯，確保系統各部分使用一致的薪資計算方法。
 * 通過版本管理和可配置規則，處理不同情況下的計算需求。
 *
 * 重要提示：這個模塊同時被前端和後端共享，使用時應避免循環依賴問題。
 * 如果遇到導入問題，建議在各自文件中直接定義所需的接口和類型，而不是從此處導入。
 */

/**
 * 加班時數結構
 */
import { constants as sharedConstants } from './constants';
import {
  calculateGrossSalary as sharedCalculateGrossSalary,
  calculateNetSalary as sharedCalculateNetSalary,
  calculateOvertimePay as sharedCalculateOvertimePay,
  normalizeSalarySettings
} from './utils/salaryMath';

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
 * 計算模型特殊情況處理結果
 */
export interface SpecialCaseResult {
  totalOvertimePay: number; // 總加班費
  grossSalary: number;      // 毛薪資
  netSalary: number;        // 淨薪資
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
  grossSalary: number;      // 要使用的毛薪資
  netSalary: number;        // 要使用的淨薪資
  description?: string;     // 規則描述
}

/**
 * 完整計算模型
 */
export interface CalculationModel {
  // 基本配置
  baseConfiguration: CalculationSettings;

  // 計算函數
  calculateOvertimePay: (overtimeHours: OvertimeHours, settings: CalculationSettings) => number;
  calculateGrossSalary: (baseSalary: number, overtimePay: number, holidayPay: number, welfareAllowance: number, housingAllowance: number) => number;
  calculateNetSalary: (grossSalary: number, totalDeductions: number) => number;

  // 特殊情況處理
  checkSpecialCase: (year: number, month: number, employeeId: number, overtimeHours: OvertimeHours, baseSalary: number, welfareAllowance?: number, housingAllowance?: number) => SpecialCaseResult | null;

  // 版本信息
  version: string;
  description: string;
}

// 特殊規則存儲：初始為空；伺服器啟動時由 server/services/calculationRulesLoader.ts
// 從 calculation_rules 資料表載入並透過 registerSpecialRule() 注入。
const specialRules: SpecialCaseRule[] = [];

/**
 * 單日加班記錄界面
 */
export interface DailyOvertimeRecord {
  date: string;      // 日期 (YYYY-MM-DD)
  ot1Hours: number;  // 當日第一階段加班時數 (1.34倍)
  ot2Hours: number;  // 當日第二階段加班時數 (1.67倍)
}

/**
 * 標準計算邏輯的實現 - 使用共用的加班與薪資公式
 */
export const standardCalculationLogic = {
  /**
   * 計算單日加班費 - 每日單獨計算後再加總，避免月彙總誤差
   */
  calculateDailyOvertimePay: (record: DailyOvertimeRecord, settings: CalculationSettings): number => {
    const { baseHourlyRate, ot1Multiplier, ot2Multiplier } = settings;

    // 計算精確時薪 (不取整)
    const ot1HourlyRate = baseHourlyRate * ot1Multiplier;
    const ot2HourlyRate = baseHourlyRate * ot2Multiplier;

    // 計算該日各階段加班費 (不預先四捨五入)
    const dailyOt1Pay = ot1HourlyRate * record.ot1Hours;
    const dailyOt2Pay = ot2HourlyRate * record.ot2Hours;

    // 將該日各階段加班費四捨五入為整數，並加總
    const dailyOvertimePay = Math.round(dailyOt1Pay) + Math.round(dailyOt2Pay);

    return dailyOvertimePay;
  },

  /**
   * 計算整月加班費 - 正確方法：每日單獨計算後加總
   */
  calculateMonthlyOvertimePayByDaily: (dailyRecords: DailyOvertimeRecord[], settings: CalculationSettings): number => {
    // 計算每日加班費並加總
    return dailyRecords.reduce((total, record) => {
      const dailyPay = standardCalculationLogic.calculateDailyOvertimePay(record, settings);
      return total + dailyPay;
    }, 0);
  },

  /**
   * 舊的方法 (不推薦使用) - 將月加班時數一次性計算
   * 只保留以兼容舊代碼，新的計算應使用 calculateMonthlyOvertimePayByDaily
   */
  calculateOvertimePay: (overtimeHours: OvertimeHours, settings: CalculationSettings): number => {
    const { baseHourlyRate, ot1Multiplier, ot2Multiplier } = settings;
    const { totalOT1Hours, totalOT2Hours } = overtimeHours;

    // 計算精確時薪 (不取整)
    const ot1HourlyRate = baseHourlyRate * ot1Multiplier;
    const ot2HourlyRate = baseHourlyRate * ot2Multiplier;

    // 計算各階段加班費 (不預先四捨五入)
    const ot1Pay = ot1HourlyRate * totalOT1Hours;
    const ot2Pay = ot2HourlyRate * totalOT2Hours;

    // 將各階段加班費四捨五入為整數
    const roundedOt1Pay = Math.round(ot1Pay);
    const roundedOt2Pay = Math.round(ot2Pay);

    // 返回總加班費
    return roundedOt1Pay + roundedOt2Pay;
  },

  // 總薪資計算
  calculateGrossSalary: (
    baseSalary: number,
    overtimePay: number,
    holidayPay: number = 0,
    welfareAllowance: number = 0,
    housingAllowance: number = 0
  ): number => {
    return baseSalary + overtimePay + holidayPay + welfareAllowance + housingAllowance;
  },

  // 淨薪資計算
  calculateNetSalary: (grossSalary: number, totalDeductions: number): number => {
    return grossSalary - totalDeductions;
  }
};

/**
 * 標準計算模型 - 適用於大多數情況
 */
export const standardCalculationModel: CalculationModel = {
  baseConfiguration: {
    baseHourlyRate: sharedConstants.BASE_HOURLY_RATE,
    ot1Multiplier: sharedConstants.OT1_MULTIPLIER,
    ot2Multiplier: sharedConstants.OT2_MULTIPLIER,
    baseMonthSalary: sharedConstants.BASE_HOURLY_RATE * sharedConstants.STANDARD_WORK_DAYS * sharedConstants.STANDARD_WORK_HOURS,
    welfareAllowance: sharedConstants.DEFAULT_WELFARE_ALLOWANCE
  },

  calculateOvertimePay: standardCalculationLogic.calculateOvertimePay,
  calculateGrossSalary: standardCalculationLogic.calculateGrossSalary,
  calculateNetSalary: standardCalculationLogic.calculateNetSalary,

  checkSpecialCase: (year: number, month: number, employeeId: number, overtimeHours: OvertimeHours, baseSalary: number, welfareAllowance?: number, housingAllowance?: number): SpecialCaseResult | null => {
    // 檢查是否有匹配的資料驅動特殊規則
    for (const rule of specialRules) {
      if (rule.year !== year || rule.month !== month) {
        continue;
      }

      if (rule.employeeId !== undefined && rule.employeeId !== employeeId) {
        continue;
      }

      if (
        Math.abs(rule.totalOT1Hours - overtimeHours.totalOT1Hours) > 0.01 ||
        Math.abs(rule.totalOT2Hours - overtimeHours.totalOT2Hours) > 0.01 ||
        Math.abs(rule.baseSalary - baseSalary) > 0.01
      ) {
        continue;
      }

      const welfareMatch =
        rule.welfareAllowance === undefined ||
        Math.abs((rule.welfareAllowance || 0) - (welfareAllowance || 0)) <= 0.01;

      const housingMatch =
        rule.housingAllowance === undefined ||
        Math.abs((rule.housingAllowance || 0) - (housingAllowance || 0)) <= 0.01;

      if (welfareMatch && housingMatch) {
        return {
          totalOvertimePay: rule.totalOvertimePay,
          grossSalary: rule.grossSalary,
          netSalary: rule.netSalary
        };
      }
    }

    return null;
  },

  version: "1.0.0",
  description: "標準薪資計算模型 - 使用共用公式與資料驅動規則"
};

/**
 * 註冊特殊規則
 */
export function registerSpecialRule(rule: SpecialCaseRule): void {
  // 檢查是否已存在相同條件的規則
  const existingRuleIndex = specialRules.findIndex(r =>
    r.year === rule.year &&
    r.month === rule.month &&
    r.employeeId === rule.employeeId &&
    Math.abs(r.totalOT1Hours - rule.totalOT1Hours) <= 0.01 &&
    Math.abs(r.totalOT2Hours - rule.totalOT2Hours) <= 0.01 &&
    Math.abs(r.baseSalary - rule.baseSalary) <= 0.01
  );

  if (existingRuleIndex >= 0) {
    // 更新現有規則
    specialRules[existingRuleIndex] = rule;
  } else {
    // 添加新規則
    specialRules.push(rule);
  }
}

/**
 * 獲取所有特殊規則
 */
export function getAllSpecialRules(): SpecialCaseRule[] {
  return [...specialRules];
}

/**
 * 清除所有特殊規則
 */
export function clearAllSpecialRules(): void {
  specialRules.length = 0;
}

/**
 * 版本化計算模型 - 可從數據庫載入特殊規則
 * 支持通過計算規則數據庫自定義的特殊情況
 */
export const april2025CalculationModel: CalculationModel = {
  ...standardCalculationModel,
  checkSpecialCase: standardCalculationModel.checkSpecialCase,
  version: "2025.4.2",
  description: "版本化薪資計算模型 - 支援資料驅動特殊規則"
};

/**
 * 版本化計算模型集合
 */
export const calculationModels: { [key: string]: CalculationModel } = {
  "standard": standardCalculationModel,
  "2025.4": april2025CalculationModel
};

/**
 * 根據年份和月份選擇適當的計算模型
 */
export function selectCalculationModel(year: number, month: number): CalculationModel {
  // 在版本化模型中查找是否有對應的規則集
  const modelKey = `${year}.${month}`;
  if (calculationModels[modelKey]) {
    return calculationModels[modelKey];
  }

  // 默認使用標準模型 - 確保所有月份都使用統一標準
  return calculationModels["standard"];
}

/**
 * 整合計算函數 - 統一入口點
 * 根據輸入參數選擇適當的計算模型並執行計算
 */
export function calculateSalary(
  year: number,
  month: number,
  employeeId: number,
  overtimeHours: OvertimeHours,
  baseSalary: number,
  totalDeductions: number,
  settings?: CalculationSettings,
  holidayPay: number = 0,
  welfareAllowance?: number,
  housingAllowance: number = 0
): SalaryCalculationResult {
  // 選擇適當的計算模型
  const model = selectCalculationModel(year, month);

  // 使用模型配置或提供的配置
  const config = normalizeSalarySettings(settings || model.baseConfiguration);

  // 檢查是否有適用的特殊情況
  const specialCase = model.checkSpecialCase(
    year, month, employeeId, overtimeHours, baseSalary, welfareAllowance, housingAllowance
  );

  if (specialCase) {
    // 對於特殊情況，使用特定的計算結果
    return {
      totalOT1Hours: overtimeHours.totalOT1Hours,
      totalOT2Hours: overtimeHours.totalOT2Hours,
      totalOvertimePay: specialCase.totalOvertimePay,
      grossSalary: specialCase.grossSalary,
      netSalary: specialCase.netSalary
    };
  }

  // 標準計算流程
  // 1. 計算加班費
  const totalOvertimePay = sharedCalculateOvertimePay(overtimeHours, config);

  // 2. 計算總薪資
  const welfareAmount = welfareAllowance !== undefined ? welfareAllowance : (config.welfareAllowance || 0);
  const grossSalary = sharedCalculateGrossSalary(baseSalary, totalOvertimePay, holidayPay, welfareAmount, housingAllowance);

  // 3. 計算淨薪資
  const netSalary = sharedCalculateNetSalary(grossSalary, totalDeductions);

  return {
    totalOT1Hours: overtimeHours.totalOT1Hours,
    totalOT2Hours: overtimeHours.totalOT2Hours,
    totalOvertimePay,
    grossSalary,
    netSalary
  };
}

/**
 * 驗證薪資記錄是否符合計算標準
 */
export function validateSalaryRecord(
  year: number,
  month: number,
  employeeId: number,
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
  settings?: CalculationSettings
): boolean {
  // 選擇適當的計算模型
  const model = selectCalculationModel(year, month);

  // 使用模型配置或提供的配置
  const config = normalizeSalarySettings(settings || model.baseConfiguration);

  // 檢查是否有適用的特殊情況
  const specialCase = model.checkSpecialCase(
    year,
    month,
    employeeId,
    { totalOT1Hours: record.totalOT1Hours, totalOT2Hours: record.totalOT2Hours },
    record.baseSalary,
    record.welfareAllowance,
    record.housingAllowance
  );

  if (specialCase) {
    // 對於特殊情況，直接比較結果
    return Math.abs(record.totalOvertimePay - specialCase.totalOvertimePay) <= 1 &&
           Math.abs(record.grossSalary - specialCase.grossSalary) <= 1 &&
           Math.abs(record.netSalary - specialCase.netSalary) <= 1;
  }

  // 標準驗證流程
  // 1. 計算預期的加班費
  const expectedOvertimePay = sharedCalculateOvertimePay({ totalOT1Hours: record.totalOT1Hours, totalOT2Hours: record.totalOT2Hours }, config);

  // 允許±1元的誤差
  return Math.abs(record.totalOvertimePay - expectedOvertimePay) <= 1;
}
