import { describe, expect, it } from 'vitest';

import {
  getSalaryAutomationConfig,
  getSalaryAutomationConfigWarnings,
  isSalaryEmailConfigured,
  parseEmailRecipients,
} from './salaryAutomation';

describe('salary automation config', () => {
  it('parses comma-separated recipients and trims blank entries', () => {
    expect(parseEmailRecipients('payroll@example.com, boss@example.com, ,')).toEqual([
      'payroll@example.com',
      'boss@example.com',
    ]);
  });

  it('reports email as configured only when SMTP and recipients are present', () => {
    const config = getSalaryAutomationConfig({
      SALARY_AUTOMATION_ENABLED: 'true',
      SALARY_AUTOMATION_EMAIL_TO: 'payroll@example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_FROM: 'Payroll <payroll@example.com>',
    });

    expect(config.enabled).toBe(true);
    expect(config.emailRecipients).toEqual(['payroll@example.com']);
    expect(isSalaryEmailConfigured(config)).toBe(true);
    expect(getSalaryAutomationConfigWarnings(config)).toEqual([]);
  });

  it('keeps the scheduler disabled by default and surfaces missing setup warnings', () => {
    const config = getSalaryAutomationConfig({});

    expect(config.enabled).toBe(false);
    expect(isSalaryEmailConfigured(config)).toBe(false);
    expect(getSalaryAutomationConfigWarnings(config)).toEqual([
      'SALARY_AUTOMATION_ENABLED is not true; scheduler is disabled.',
      'SALARY_AUTOMATION_EMAIL_TO is not configured.',
      'SMTP_HOST is not configured.',
      'SMTP_FROM is not configured.',
    ]);
  });
});
