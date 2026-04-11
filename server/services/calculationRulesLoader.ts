/**
 * 從資料庫載入薪資計算特殊規則
 *
 * 在伺服器啟動時呼叫，將 calculation_rules 表中的有效規則注入到
 * shared/calculationModel 的 specialRules 記憶體陣列中。
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { calculationRules } from '@shared/schema';
import { registerSpecialRule, clearAllSpecialRules } from '@shared/calculationModel';
import { createLogger } from '../utils/logger';

const log = createLogger('calc-rules-loader');

async function fetchAndRegisterRules(): Promise<number> {
  const rules = await db
    .select()
    .from(calculationRules)
    .where(eq(calculationRules.isActive, true));

  for (const rule of rules) {
    registerSpecialRule({
      year: rule.year,
      month: rule.month,
      employeeId: rule.employeeId ?? undefined,
      totalOT1Hours: rule.totalOT1Hours,
      totalOT2Hours: rule.totalOT2Hours,
      baseSalary: rule.baseSalary,
      welfareAllowance: rule.welfareAllowance ?? undefined,
      housingAllowance: rule.housingAllowance ?? undefined,
      totalOvertimePay: rule.totalOvertimePay,
      grossSalary: rule.grossSalary,
      netSalary: rule.netSalary,
    });
  }

  return rules.length;
}

/** 啟動時呼叫：從 DB 載入所有有效的薪資計算特殊規則到記憶體。 */
export async function loadCalculationRulesFromDb(): Promise<void> {
  try {
    const count = await fetchAndRegisterRules();
    log.info(`已從資料庫載入 ${count} 條薪資計算特殊規則`);
  } catch (error) {
    log.error('載入薪資計算特殊規則失敗：', error);
  }
}

/**
 * 清除記憶體中的特殊規則並從 DB 重新載入。
 * 在更新 calculation_rules 表後呼叫，使新規則立即生效，無需重啟伺服器。
 */
export async function reloadCalculationRulesFromDb(): Promise<number> {
  clearAllSpecialRules();
  const count = await fetchAndRegisterRules();
  log.info(`薪資計算特殊規則已重載：${count} 條`);
  return count;
}
