export interface SalaryMonthTarget {
  year: number;
  month: number;
}

export interface SalaryAutomationRunRequest extends SalaryMonthTarget {
  force: true;
  sendEmail: true;
}

export function formatSalaryMonth(target: SalaryMonthTarget): string {
  return `${target.year} 年 ${target.month} 月`;
}

export function buildSalaryAutomationRunRequest(
  target: SalaryMonthTarget,
): SalaryAutomationRunRequest {
  return {
    ...target,
    force: true,
    sendEmail: true,
  };
}
