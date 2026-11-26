import { parseBoolean } from './salaryAutomation';

export interface PayrollReviewConfig {
  /** 月結前檢查：有疑點就暫停自動月結、寄信，等後台確認。預設開啟。 */
  enabled: boolean;
}

export function getPayrollReviewConfig(env: NodeJS.ProcessEnv = process.env): PayrollReviewConfig {
  return { enabled: parseBoolean(env.PAYROLL_REVIEW_ENABLED, true) };
}
