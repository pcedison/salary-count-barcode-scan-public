import { describe, expect, it } from 'vitest';

import {
  getSalaryAutomationConfig,
  getSalaryAutomationConfigWarnings,
  getSalaryEmailSender,
  getSalaryEmailTransport,
  isSalaryEmailConfigured,
  isSalaryEmailTransportConfigured,
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

  it('keeps SMTP as the transport when RESEND_API_KEY is absent or blank', () => {
    for (const RESEND_API_KEY of [undefined, '', '   ']) {
      const config = getSalaryAutomationConfig({
        RESEND_API_KEY,
        RESEND_FROM: 'Payroll <payroll@mail.example.com>',
        SALARY_AUTOMATION_EMAIL_TO: 'payroll@example.com',
      });

      expect(getSalaryEmailTransport(config)).toBe('smtp');
      expect(isSalaryEmailConfigured(config)).toBe(false);
    }
  });

  it('treats Resend as configured without SMTP_HOST', () => {
    const config = getSalaryAutomationConfig({
      SALARY_AUTOMATION_ENABLED: 'true',
      SALARY_AUTOMATION_EMAIL_TO: 'payroll@example.com',
      RESEND_API_KEY: ' synthetic-resend-key ',
      RESEND_FROM: 'Payroll <payroll@mail.example.com>',
    });

    expect(config.resendApiKey).toBe('synthetic-resend-key');
    expect(getSalaryEmailTransport(config)).toBe('resend');
    expect(getSalaryEmailSender(config)).toBe('Payroll <payroll@mail.example.com>');
    expect(isSalaryEmailTransportConfigured(config)).toBe(true);
    expect(isSalaryEmailConfigured(config)).toBe(true);
    expect(getSalaryAutomationConfigWarnings(config)).toEqual([]);
  });

  it('requires RESEND_FROM in Resend mode without falling back to SMTP_FROM', () => {
    const config = getSalaryAutomationConfig({
      SALARY_AUTOMATION_ENABLED: 'true',
      SALARY_AUTOMATION_EMAIL_TO: 'payroll@example.com',
      RESEND_API_KEY: 'synthetic-resend-key',
      SMTP_FROM: 'Payroll <payroll@gmail.example.com>',
    });

    expect(getSalaryEmailSender(config)).toBeUndefined();
    expect(isSalaryEmailTransportConfigured(config)).toBe(false);
    expect(isSalaryEmailConfigured(config)).toBe(false);
    expect(getSalaryAutomationConfigWarnings(config)).toEqual(['RESEND_FROM is not configured.']);
  });

  it('still requires recipients in Resend mode', () => {
    const config = getSalaryAutomationConfig({
      RESEND_API_KEY: 'synthetic-resend-key',
      RESEND_FROM: 'Payroll <payroll@mail.example.com>',
    });

    expect(isSalaryEmailTransportConfigured(config)).toBe(true);
    expect(isSalaryEmailConfigured(config)).toBe(false);
  });
});
